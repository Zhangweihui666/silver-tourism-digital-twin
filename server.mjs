import http from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8092);
const mime = {
  '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8','.ply':'application/octet-stream','.splat':'application/octet-stream',
  '.ksplat':'application/octet-stream','.spz':'application/octet-stream','.glb':'model/gltf-binary','.gltf':'model/gltf+json',
  '.obj':'text/plain; charset=utf-8','.wasm':'application/wasm','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'
};
const projectPython = path.join(root, '.venv', 'Scripts', 'python.exe');
const bundledPython = path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
const python = process.env.SILVER_PYTHON || (existsSync(projectPython) ? projectPython : (existsSync(bundledPython) ? bundledPython : 'python'));
const uploadRoot = path.join(root, 'uploads');
const allowedSceneExtensions = new Set(['.ply','.splat','.ksplat','.spz']);
const appVersion = '3.5.0';

function headers(type) {
  return {
    'Content-Type': type,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin'
  };
}
function readBody(req, limit=80*1024*1024) {
  return new Promise((resolve,reject)=>{const chunks=[];let size=0;req.on('data',chunk=>{size+=chunk.length;if(size>limit){reject(new Error('Request too large'));req.destroy()}else chunks.push(chunk)});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject)});
}

function validateModelEndpoint(baseUrl) {
  const endpoint = new URL(baseUrl);
  const local = ['localhost','127.0.0.1','::1'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:')) throw new Error('模型接口必须使用 HTTPS；仅本机 localhost 可使用 HTTP');
  if (!local && /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(endpoint.hostname)) throw new Error('不允许访问内网模型地址');
  if (!endpoint.pathname.endsWith('/chat/completions')) endpoint.pathname = `${endpoint.pathname.replace(/\/$/,'')}/chat/completions`.replace(/\/+/g,'/');
  return endpoint;
}

function parseStrategyContent(content) {
  const text = String(content || '').replace(/^```(?:json)?/i,'').replace(/```$/,'').trim();
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型未返回有效 JSON 策略');
  const source = JSON.parse(text.slice(start, end + 1));
  const clamp = (value, min, max, fallback) => Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : fallback));
  return {
    navigationBoost: clamp(source.navigationBoost, 0, .35, .08),
    signBoost: clamp(source.signBoost, 0, .35, .08),
    safetyBoost: clamp(source.safetyBoost, 0, .35, .08),
    paceFactor: clamp(source.paceFactor, .7, 1.25, 1),
    restBias: clamp(source.restBias, 0, .25, .05),
    confusionMultiplier: clamp(source.confusionMultiplier, .35, 1.4, .8),
    targetPreference: source.targetPreference === 'nearest' ? 'nearest' : 'balanced',
    rationale: String(source.rationale || '模型生成的分组游览策略').slice(0, 500)
  };
}

function parseSceneAnalysisContent(content) {
  const text = String(content || '').replace(/^```(?:json)?/i,'').replace(/```$/,'').trim();
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('视觉模型未返回有效 JSON 场景结果');
  const source = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(source.objects)) throw new Error('视觉模型结果缺少 objects 数组');
  const allowedTypes = new Set(['building','road','sidewalk','plaza','stairs','vehicle','tree','sign','bench','barrier','light','other']);
  const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
  const objects = source.objects.slice(0, 300).map((object, index) => {
    const polygon = Array.isArray(object.polygon) ? object.polygon.slice(0, 24).map(point => [clamp(point?.[0]), clamp(point?.[1])]) : [];
    const bbox = Array.isArray(object.bbox) ? object.bbox.slice(0, 4).map(clamp) : [];
    const type = allowedTypes.has(object.type) ? object.type : 'other';
    return {
      viewIndex: Math.max(0, Math.floor(Number(object.viewIndex) || 0)), type,
      label: String(object.label || `${type}-${index + 1}`).slice(0, 120), confidence: clamp(object.confidence || .5),
      polygon, bbox, crossViewId: String(object.crossViewId || '').slice(0, 80),
      dimensions: {
        width: Math.max(0, Number(object.dimensions?.width) || 0), depth: Math.max(0, Number(object.dimensions?.depth) || 0), height: Math.max(0, Number(object.dimensions?.height) || 0)
      }
    };
  }).filter(object => object.polygon.length >= 3 || object.bbox.length === 4);
  return { objects, sceneSummary: String(source.sceneSummary || '').slice(0, 1200), limitations: Array.isArray(source.limitations) ? source.limitations.map(item => String(item).slice(0, 300)).slice(0, 20) : [] };
}

function describeNetworkError(error) {
  const causes = error?.cause?.errors || (error?.cause ? [error.cause] : []);
  const details = causes.map(item => [item.code, item.address && `${item.address}:${item.port}`].filter(Boolean).join(' ')).filter(Boolean).join('；');
  if (causes.some(item => item.code === 'EACCES')) return `系统阻止了服务端访问模型接口（EACCES${details ? `：${details}` : ``}）。请在 Windows 防火墙中允许 node.exe 访问 HTTPS，或设置 HTTPS_PROXY 后重新启动应用。`;
  if (causes.some(item => item.code === 'ENOTFOUND')) return `模型接口域名解析失败${details ? `（${details}）` : ``}。`;
  if (causes.some(item => ['ECONNREFUSED','ETIMEDOUT','ECONNRESET'].includes(item.code))) return `模型接口连接失败${details ? `（${details}）` : ``}。`;
  return error?.message || '模型接口调用失败';
}

function postJson(endpoint, payload, apiKey, signal) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const request = httpsRequest(endpoint, { method:'POST', headers:{'Content-Type':'application/json','Content-Length':body.length,Authorization:`Bearer ${apiKey}`}, signal }, response => {
      const chunks=[]; response.on('data',chunk=>chunks.push(chunk)); response.on('end',()=>resolve({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode,text:async()=>Buffer.concat(chunks).toString('utf8')}));
    });
    request.on('error',reject); request.end(body);
  });
}

function postJsonViaPython(endpoint,payload,apiKey,signal){
  return new Promise((resolve,reject)=>{
    const child=spawn(python,[path.join(root,'llm_proxy.py')],{cwd:root,windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1'}});const stdout=[],stderr=[];
    const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});child.stdout.on('data',data=>stdout.push(data));child.stderr.on('data',data=>stderr.push(data));child.on('error',reject);
    child.on('close',code=>{signal?.removeEventListener('abort',abort);if(signal?.aborted)return reject(Object.assign(new Error('aborted'),{name:'AbortError'}));if(code!==0)return reject(new Error(Buffer.concat(stderr).toString('utf8')||`Python proxy exited ${code}`));try{const result=JSON.parse(Buffer.concat(stdout).toString('utf8'));if(result.networkError)throw new Error(`Python 网络回退失败：${result.networkError}`);resolve({ok:result.ok,status:result.status,text:async()=>result.body||''});}catch(error){reject(error);}});
    child.stdin.end(JSON.stringify({endpoint:endpoint.href,payload,apiKey}));
  });
}

function postJsonViaPowerShell(endpoint,payload,apiKey,signal){
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'llm_proxy.ps1')],{cwd:root,windowsHide:true});const stdout=[],stderr=[];
    const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});child.stdout.on('data',data=>stdout.push(data));child.stderr.on('data',data=>stderr.push(data));child.on('error',reject);
    child.on('close',code=>{signal?.removeEventListener('abort',abort);if(signal?.aborted)return reject(Object.assign(new Error('aborted'),{name:'AbortError'}));if(code!==0)return reject(new Error(Buffer.concat(stderr).toString('utf8')||`PowerShell proxy exited ${code}`));try{const result=JSON.parse(Buffer.concat(stdout).toString('utf8').replace(/^\uFEFF/,''));if(result.networkError)throw new Error(result.networkError);resolve({ok:result.ok,status:result.status,text:async()=>result.body||''});}catch(error){reject(error);}});
    child.stdin.end(JSON.stringify({endpoint:endpoint.href,payload,apiKey}));
  });
}

async function llmStrategy(req,res) {
  try {
    const input = JSON.parse((await readBody(req,2*1024*1024)).toString('utf8'));
    if (!input.apiKey) throw new Error('当前策略组未填写 API Key');
    if (!input.baseUrl || !input.model) throw new Error('请填写模型接口地址和模型名称');
    const endpoint = validateModelEndpoint(input.baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    const prompt = `你是历史文化街区银发旅游仿真的组级策略器。请根据以下Agent组、子任务分布与场景参数，输出一个JSON对象，用于调整组内Agent的策略，但不得覆盖个体行为特征。\nAgent组：${JSON.stringify(input.group)}\n场景：${JSON.stringify(input.scenario)}\n仅返回JSON，字段必须为：navigationBoost(0~0.35), signBoost(0~0.35), safetyBoost(0~0.35), paceFactor(0.7~1.25), restBias(0~0.25), confusionMultiplier(0.35~1.4), targetPreference(nearest或balanced), rationale(中文简述)。`;
    let upstream;
    try {
      const payload={model:input.model,messages:[{role:'system',content:'你只输出符合要求的JSON对象，不输出Markdown。'},{role:'user',content:prompt}],temperature:.2};
      try { upstream = await fetch(endpoint, { method:'POST', signal:controller.signal, headers:{'Content-Type':'application/json','Authorization':`Bearer ${input.apiKey}`}, body:JSON.stringify(payload) }); }
      catch (fetchError) { try { upstream = await postJson(endpoint,payload,input.apiKey,controller.signal); } catch { try { upstream = await postJsonViaPython(endpoint,payload,input.apiKey,controller.signal); } catch { try { upstream = await postJsonViaPowerShell(endpoint,payload,input.apiKey,controller.signal); } catch (powerShellError) { powerShellError.cause=fetchError; throw powerShellError; } } } }
    } finally { clearTimeout(timer); }
    const body = await upstream.text();
    if (!upstream.ok) throw new Error(`模型接口返回 ${upstream.status}：${body.slice(0,500)}`);
    const data = JSON.parse(body);
    const strategy = parseStrategyContent(data.choices?.[0]?.message?.content);
    const response = Buffer.from(JSON.stringify({strategy,usage:data.usage||{},provider:input.provider||'custom',model:input.model}));
    res.writeHead(200,{...headers('application/json; charset=utf-8'),'Content-Length':response.length});res.end(response);
  } catch(error) {
    const message = error.name === 'AbortError' ? '模型接口调用超时（90秒）' : describeNetworkError(error);
    res.writeHead(400,headers('text/plain; charset=utf-8'));res.end(message);
  }
}

async function analyzeSceneImages(req,res) {
  try {
    const input = JSON.parse((await readBody(req,45*1024*1024)).toString('utf8'));
    if (!input.apiKey) throw new Error('请填写多模态模型 API Key');
    if (!input.baseUrl || !input.model) throw new Error('请填写多模态模型接口地址和视觉模型名称');
    if (!Array.isArray(input.images) || !input.images.length) throw new Error('没有收到场景图片');
    if (input.images.length > 12) throw new Error('一次最多解析 12 张场景图片');
    const endpoint = validateModelEndpoint(input.baseUrl), controller = new AbortController(), timer = setTimeout(() => controller.abort(), 180000);
    const prompt = `你是历史文化街区“图片辅助语义数字孪生”解析器。分析全部图片，识别可用于三维代理重建的建筑、道路、人行道、广场、台阶、车辆、树木、导视牌、座椅、隔离设施和路灯。\n输入共有 ${input.images.length} 个视角，顺序和方向为：${input.images.map((image,index)=>`${index}:${image.orientation}:${image.name}`).join('；')}。\n场景预估范围 ${Number(input.sceneWidth)||60}m × ${Number(input.sceneDepth)||100}m，模式 ${input.mode||'measured'}。\n只返回一个 JSON 对象，不要 Markdown。结构：{"objects":[{"viewIndex":0,"type":"building|road|sidewalk|plaza|stairs|vehicle|tree|sign|bench|barrier|light|other","label":"中文名称","confidence":0.0,"polygon":[[x,y],...],"bbox":[x1,y1,x2,y2],"crossViewId":"同一物体跨视图共用ID，可空","dimensions":{"width":0,"depth":0,"height":0}}],"sceneSummary":"中文概述","limitations":["不确定性"]}。\n坐标必须归一化到 0~1。polygon 沿物体边界给出 4~12 点；无法可靠分割时给 bbox。不要虚构遮挡后的结构；不确定尺寸填 0；同一对象在不同视图出现时使用相同 crossViewId。道路和人行道必须优先识别。`;
    const content = [{ type:'text', text:prompt }];
    for (const image of input.images) {
      if (!/^data:image\/(?:jpeg|png|webp);base64,/i.test(image.dataUrl || '')) throw new Error(`图片 ${image.name || ''} 格式无效`);
      content.push({ type:'image_url', image_url:{ url:image.dataUrl, detail:'high' } });
    }
    const payload = { model:input.model, messages:[{role:'system',content:'你只输出严格 JSON。对看不清或无法推断的内容降低 confidence，不得编造。'},{role:'user',content}], temperature:.1, max_tokens:12000 };
    let upstream;
    try {
      try { upstream = await fetch(endpoint, { method:'POST', signal:controller.signal, headers:{'Content-Type':'application/json','Authorization':`Bearer ${input.apiKey}`}, body:JSON.stringify(payload) }); }
      catch (fetchError) { try { upstream = await postJson(endpoint,payload,input.apiKey,controller.signal); } catch { try { upstream = await postJsonViaPython(endpoint,payload,input.apiKey,controller.signal); } catch { try { upstream = await postJsonViaPowerShell(endpoint,payload,input.apiKey,controller.signal); } catch (powerShellError) { powerShellError.cause=fetchError; throw powerShellError; } } } }
    } finally { clearTimeout(timer); }
    const body = await upstream.text();
    if (!upstream.ok) throw new Error(`视觉模型接口返回 ${upstream.status}：${body.slice(0,800)}`);
    const data = JSON.parse(body), analysis = parseSceneAnalysisContent(data.choices?.[0]?.message?.content);
    const response = Buffer.from(JSON.stringify({...analysis,usage:data.usage||{},model:input.model}));
    res.writeHead(200,{...headers('application/json; charset=utf-8'),'Content-Length':response.length});res.end(response);
  } catch(error) {
    const message = error.name === 'AbortError' ? '视觉模型接口调用超时（180秒）' : describeNetworkError(error);
    res.writeHead(400,headers('text/plain; charset=utf-8'));res.end(message);
  }
}

const worldLabsBase = 'https://api.worldlabs.ai/marble/v1';
const generatedWorldCache = new Map();
function worldLabsHeaders(apiKey,json=true){return {'WLT-Api-Key':apiKey,...(json?{'Content-Type':'application/json'}:{})}}
async function worldLabsJson(url,options={}){const response=await fetch(url,options),text=await response.text();if(!response.ok)throw new Error(`World API 请求失败 ${response.status}: ${text.slice(0,800)}`);return text?JSON.parse(text):{}}
function safeWorldId(value){return String(value||randomUUID()).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80)||randomUUID()}
async function downloadWorldAsset(url,target){if(!url)return null;const source=new URL(url);if(source.protocol!=='https:')throw new Error('World 资源必须使用 HTTPS');const response=await fetch(source);if(!response.ok||!response.body)throw new Error(`下载 World 资源失败：${response.status}`);await pipeline(Readable.fromWeb(response.body),createWriteStream(target));return target}
function selectSpzAsset(world,quality='full_res'){const urls=world?.assets?.splats?.spz_urls||{},ordered=[quality,'full_res','500k','100k'];for(const key of ordered)if(urls[key])return{quality:key,url:urls[key]};const first=Object.entries(urls)[0];return first?{quality:first[0],url:first[1]}:{quality:'',url:''}}
async function ensureWorldAsset(source,target){if(!source)return false;try{const info=await stat(target);if(info.size>0)return true}catch{}await downloadWorldAsset(source,target);return true}
async function cacheGeneratedWorld(world,quality='100k',{includeCollider=true}={}){
  const worldId=safeWorldId(world?.world_id||world?.id),folder=path.join(uploadRoot,'worldlabs',worldId);await mkdir(folder,{recursive:true});
  const selected=selectSpzAsset(world,quality),colliderSource=includeCollider?(world?.assets?.mesh?.collider_mesh_url||''):'',spzPath=path.join(folder,`world-${selected.quality||quality}.spz`),colliderPath=path.join(folder,'collider.glb');
  const [hasSpz,hasCollider]=await Promise.all([ensureWorldAsset(selected.url,spzPath),ensureWorldAsset(colliderSource,colliderPath)]);
  return {worldId,quality:selected.quality||quality,availableQualities:Object.keys(world?.assets?.splats?.spz_urls||{}),displayName:world?.display_name||'Marble World',caption:world?.assets?.caption||'',marbleUrl:world?.world_marble_url||'',spzUrl:hasSpz?`/uploads/worldlabs/${worldId}/world-${selected.quality||quality}.spz`:'',colliderUrl:hasCollider?`/uploads/worldlabs/${worldId}/collider.glb`:'',semanticsMetadata:world?.assets?.splats?.semantics_metadata||{}};
}
async function resolveGeneratedWorld(apiKey,operationId){
  if(generatedWorldCache.has(operationId))return generatedWorldCache.get(operationId);const operation=await worldLabsJson(`${worldLabsBase}/operations/${encodeURIComponent(operationId)}`,{headers:worldLabsHeaders(apiKey,false)});if(operation.error)throw new Error(operation.error.message||'World 操作异常');if(!operation.done||!operation.response)throw new Error('Marble 任务尚未完成');generatedWorldCache.set(operationId,operation.response);return operation.response;
}
async function cacheWorldQuality(req,res){
  try{const input=JSON.parse((await readBody(req,1024*1024)).toString('utf8')),apiKey=String(input.apiKey||''),operationId=String(input.operationId||''),quality=String(input.quality||'full_res');if(!apiKey||!operationId)throw new Error('缺少 World API 参数');const world=await resolveGeneratedWorld(apiKey,operationId),result=await cacheGeneratedWorld(world,quality,{includeCollider:false}),data=Buffer.from(JSON.stringify(result));res.writeHead(200,{...headers('application/json; charset=utf-8'),'Content-Length':data.length});res.end(data)}catch(error){res.writeHead(400,headers('text/plain; charset=utf-8'));res.end(describeNetworkError(error))}
}
async function startWorldGeneration(req,res){
  try{
    const apiKey=String(req.headers['x-worldlabs-key']||''),fileName=decodeURIComponent(String(req.headers['x-file-name']||'panorama.jpg')),isPano=String(req.headers['x-is-pano']||'true')==='true',model=String(req.headers['x-world-model']||'marble-1.1'),textPrompt=decodeURIComponent(String(req.headers['x-world-prompt']||'')),extension=(path.extname(fileName).slice(1)||'jpg').toLowerCase(),image=await readBody(req,60*1024*1024);
    if(!apiKey)throw new Error('请填写 World Labs API Key');if(!image.length)throw new Error('没有收到重建图片');
    const prepared=await worldLabsJson(`${worldLabsBase}/media-assets:prepare_upload`,{method:'POST',headers:worldLabsHeaders(apiKey),body:JSON.stringify({file_name:path.basename(fileName).slice(0,64),kind:'image',extension})});
    const upload=prepared.upload_info||{},uploadHeaders={...(upload.required_headers||{})};if(!Object.keys(uploadHeaders).some(key=>key.toLowerCase()==='content-type'))uploadHeaders['Content-Type']=String(req.headers['content-type']||'image/jpeg');
    const uploaded=await fetch(upload.upload_url,{method:upload.upload_method||'PUT',headers:uploadHeaders,body:image});if(!uploaded.ok)throw new Error(`上传 World 图片失败：${uploaded.status} ${(await uploaded.text()).slice(0,500)}`);
    const mediaAssetId=prepared.media_asset?.media_asset_id||prepared.media_asset?.id;if(!mediaAssetId)throw new Error('World API 未返回 media_asset_id');
    const payload={display_name:path.parse(fileName).name.slice(0,64),model,permission:{public:false},world_prompt:{type:'image',image_prompt:{source:'media_asset',media_asset_id:mediaAssetId,is_pano:isPano}}};if(textPrompt)payload.world_prompt.text_prompt=textPrompt;
    const operation=await worldLabsJson(`${worldLabsBase}/worlds:generate`,{method:'POST',headers:worldLabsHeaders(apiKey),body:JSON.stringify(payload)}),data=Buffer.from(JSON.stringify({operationId:operation.operation_id,done:Boolean(operation.done),metadata:operation.metadata||{}}));
    res.writeHead(200,{...headers('application/json; charset=utf-8'),'Content-Length':data.length});res.end(data);
  }catch(error){res.writeHead(400,headers('text/plain; charset=utf-8'));res.end(describeNetworkError(error))}
}
async function pollWorldGeneration(req,res){
  try{
    const input=JSON.parse((await readBody(req,1024*1024)).toString('utf8')),apiKey=String(input.apiKey||''),rawOperationId=String(input.operationId||'');if(!apiKey||!rawOperationId)throw new Error('缺少 World API 参数');
    const operation=await worldLabsJson(`${worldLabsBase}/operations/${encodeURIComponent(rawOperationId)}`,{headers:worldLabsHeaders(apiKey,false)});if(operation.error)throw new Error(operation.error.message||'World 操作异常');
    let result={done:Boolean(operation.done),operationId:operation.operation_id||rawOperationId,metadata:operation.metadata||{},requestedQuality:String(input.quality||'full_res')};if(operation.done&&operation.response){generatedWorldCache.set(rawOperationId,operation.response);result={...result,...await cacheGeneratedWorld(operation.response,'100k',{includeCollider:true})}}
    const data=Buffer.from(JSON.stringify(result));res.writeHead(200,{...headers('application/json; charset=utf-8'),'Content-Length':data.length});res.end(data);
  }catch(error){res.writeHead(400,headers('text/plain; charset=utf-8'));res.end(describeNetworkError(error))}
}

async function uploadScene(req,res) {
  try {
    const requestUrl=new URL(req.url,'http://localhost');
    const originalName=path.basename(requestUrl.searchParams.get('name')||'scene.ply');
    const extension=path.extname(originalName).toLowerCase();
    if(!allowedSceneExtensions.has(extension))throw new Error(`Unsupported 3DGS extension: ${extension}`);
    const body=await readBody(req,1024*1024*1024);
    await mkdir(uploadRoot,{recursive:true});
    const fileName=`${randomUUID()}${extension}`;
    await writeFile(path.join(uploadRoot,fileName),body);
    const data=Buffer.from(JSON.stringify({url:`/uploads/${fileName}`,name:originalName,size:body.length}));
    res.writeHead(200,{...headers('application/json; charset=utf-8'),'Content-Length':data.length});res.end(data);
  } catch(error) { res.writeHead(400,headers('text/plain; charset=utf-8'));res.end(error.message); }
}

async function figures(req,res) {
  try {
    const body = await readBody(req);
    const child = spawn(python, [path.join(root,'scientific_figures.py')], { cwd: root, env: {...process.env}, windowsHide:true });
    const stdout=[], stderr=[];
    child.stdout.on('data',d=>stdout.push(d)); child.stderr.on('data',d=>stderr.push(d));
    child.stdin.on('error',()=>{});
    child.stdin.end(body);
    child.on('close',code=>{if(code!==0){res.writeHead(500,headers('text/plain; charset=utf-8'));res.end(Buffer.concat(stderr).toString('utf8')||`Python exited ${code}`)}else{const data=Buffer.concat(stdout);res.writeHead(200,{...headers('application/zip'),'Content-Length':data.length});res.end(data)}});
    child.on('error',error=>{res.writeHead(500,headers('text/plain; charset=utf-8'));res.end(`閺冪姵纭堕崥顖氬З缁夋垹鐖虹紒妯烘禈閻滎垰顣ㄩ敍?{error.message}`)});
  } catch(error) { res.writeHead(500,headers('text/plain; charset=utf-8'));res.end(error.message); }
}
const placeSearchCache = new Map(), placeContextCache = new Map();

function sendJson(res,statusCode,payload){const data=Buffer.from(JSON.stringify(payload));res.writeHead(statusCode,{...headers('application/json; charset=utf-8'),'Content-Length':data.length});res.end(data)}
function cachedValue(cache,key,maxAge=30*60*1000){const entry=cache.get(key);if(!entry||Date.now()-entry.time>maxAge){cache.delete(key);return null}return entry.value}
function storeCache(cache,key,value){cache.set(key,{time:Date.now(),value});if(cache.size>40)cache.delete(cache.keys().next().value)}
async function fetchTextWithTimeout(url,options={},timeoutMs=25000){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);try{const response=await fetch(url,{...options,signal:controller.signal});const text=await response.text();if(!response.ok)throw new Error(`远程地图服务返回 ${response.status}: ${text.slice(0,300)}`);return text}finally{clearTimeout(timer)}}

function readJsonRequest(req,limit=1024*1024){return readBody(req,limit).then(buffer=>{const text=buffer.toString('utf8').trim();if(!text)return{};try{return JSON.parse(text)}catch{throw new Error('请求数据不是有效 JSON')}})}
function mapApiKey(req){return String(req.headers['x-map-api-key']||'').trim()}
function remoteJson(endpoint,timeoutMs=22000){
  return new Promise((resolve,reject)=>{
    const request=httpsRequest(endpoint,{method:'GET',headers:{Accept:'application/json','User-Agent':'SilverTourismDigitalTwin/3.5.0 local-research-app'}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');
        if(response.statusCode<200||response.statusCode>=300)return reject(new Error(`地图服务返回 HTTP ${response.statusCode}`));
        try{resolve(JSON.parse(text))}catch{return reject(new Error('地图服务返回了无法解析的数据'))}
      });
    });
    request.setTimeout(timeoutMs,()=>request.destroy(new Error('地图服务请求超时')));request.on('error',error=>reject(new Error(error.code==='ENOTFOUND'?'无法连接地图服务，请检查网络或防火墙':error.message||'地图服务连接失败')));request.end();
  });
}
function remoteTextRequest(endpoint,options={},timeoutMs=32000){
  return new Promise((resolve,reject)=>{
    const url=endpoint instanceof URL?endpoint:new URL(endpoint),body=options.body?Buffer.from(options.body):null,request=httpsRequest(url,{method:options.method||'GET',headers:{Accept:'application/json','User-Agent':'SilverTourismDigitalTwin/3.5.0 local-research-app',...(body?{'Content-Length':body.length}:{}),...(options.headers||{})}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');
        if(response.statusCode<200||response.statusCode>=300)return reject(new Error(`公开地图服务返回 HTTP ${response.statusCode}: ${text.slice(0,180)}`));
        resolve(text);
      });
    });
    request.setTimeout(timeoutMs,()=>request.destroy(new Error('公开地图服务请求超时')));request.on('error',reject);if(body)request.write(body);request.end();
  });
}
function coordinatePair(value){const [lon,lat]=String(value||'').split(',').map(Number);return Number.isFinite(lat)&&Number.isFinite(lon)?{lat,lon}:null}
function numericValue(value){if(value&&typeof value==='object')value=value.value;const number=Number(value);return Number.isFinite(number)?number:0}
function haversineMeters(left,right){const radians=value=>value*Math.PI/180,dLat=radians(right.lat-left.lat),dLon=radians(right.lon-left.lon),a=Math.sin(dLat/2)**2+Math.cos(radians(left.lat))*Math.cos(radians(right.lat))*Math.sin(dLon/2)**2;return 6371000*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))}
function outsideChina(lat,lon){return lon<72.004||lon>137.8347||lat<.8293||lat>55.8271}
function transformLatitude(x,y){let value=-100+2*x+3*y+.2*y*y+.1*x*y+.2*Math.sqrt(Math.abs(x));value+=(20*Math.sin(6*x*Math.PI)+20*Math.sin(2*x*Math.PI))*2/3;value+=(20*Math.sin(y*Math.PI)+40*Math.sin(y/3*Math.PI))*2/3;value+=(160*Math.sin(y/12*Math.PI)+320*Math.sin(y*Math.PI/30))*2/3;return value}
function transformLongitude(x,y){let value=300+x+2*y+.1*x*x+.1*x*y+.1*Math.sqrt(Math.abs(x));value+=(20*Math.sin(6*x*Math.PI)+20*Math.sin(2*x*Math.PI))*2/3;value+=(20*Math.sin(x*Math.PI)+40*Math.sin(x/3*Math.PI))*2/3;value+=(150*Math.sin(x/12*Math.PI)+300*Math.sin(x/30*Math.PI))*2/3;return value}
function gcj02ToWgs84(lat,lon){
  if(outsideChina(lat,lon))return{lat,lon};const axis=6378245,eccentricity=.00669342162296594323,deltaLat=transformLatitude(lon-105,lat-35),deltaLon=transformLongitude(lon-105,lat-35),radianLat=lat/180*Math.PI,magic=1-eccentricity*Math.sin(radianLat)**2,sqrtMagic=Math.sqrt(magic),latitudeDelta=deltaLat*180/((axis*(1-eccentricity))/(magic*sqrtMagic)*Math.PI),longitudeDelta=deltaLon*180/(axis/sqrtMagic*Math.cos(radianLat)*Math.PI),mappedLat=lat+latitudeDelta,mappedLon=lon+longitudeDelta;return{lat:lat*2-mappedLat,lon:lon*2-mappedLon};
}
function normalizeAmapPoi(item){const location=coordinatePair(item.location);if(!location)return null;return{id:String(item.id||''),name:String(item.name||'未命名地点'),address:[item.pname,item.cityname,item.adname,item.address].flat().filter(Boolean).join(' '),type:String(item.type||''),category:String(item.typecode||item.type||''),lat:location.lat,lon:location.lon,distance:numericValue(item.distance)}}
function normalizeBaiduPoi(item){const lat=Number(item.location?.lat),lon=Number(item.location?.lng);if(!Number.isFinite(lat)||!Number.isFinite(lon))return null;return{id:String(item.uid||''),name:String(item.name||'未命名地点'),address:[item.province,item.city,item.area||item.district,item.address].filter(Boolean).join(' '),type:String(item.detail_info?.tag||item.tag||item.type||''),category:String(item.detail_info?.classified_poi_tag||item.detail_info?.tag||item.tag||''),lat,lon,distance:numericValue(item.detail_info?.distance||item.distance)}}
function parseRoutePath(value){if(Array.isArray(value))return value.map(point=>Array.isArray(point)?[Number(point[0]),Number(point[1])]:[Number(point?.lng??point?.lon),Number(point?.lat)]).filter(point=>point.every(Number.isFinite));return String(value||'').split(';').map(pair=>pair.split(',').map(Number)).filter(point=>point.length===2&&point.every(Number.isFinite))}
function uniqueRoutePoints(points){const output=[];for(const point of points){const previous=output.at(-1);if(!previous||Math.hypot(previous[0]-point[0],previous[1]-point[1])>1e-7)output.push(point)}return output}
function routeTargets(pois,center,limit=3){const priority=poi=>/游客中心|入口|卫生间|厕所|景点|博物馆|文化|公园|休息|医院|药店/.test(`${poi.name} ${poi.type}`)?0:1;return [...pois].map(poi=>({...poi,_distance:poi.distance||haversineMeters(center,poi)})).filter(poi=>poi._distance>18&&poi._distance<1800).sort((left,right)=>priority(left)-priority(right)||left._distance-right._distance).filter((poi,index,array)=>array.findIndex(item=>item.name===poi.name&&Math.abs(item.lat-poi.lat)<1e-6&&Math.abs(item.lon-poi.lon)<1e-6)===index).slice(0,limit)}
function assertAmap(payload){if(String(payload?.status)!=='1')throw new Error(`高德地图接口失败：${payload?.info||'未知错误'}${payload?.infocode?`（${payload.infocode}）`:''}`);return payload}
function assertBaidu(payload){if(Number(payload?.status)!==0)throw new Error(`百度地图接口失败：${payload?.message||payload?.msg||'未知错误'}${payload?.status!==undefined?`（${payload.status}）`:''}`);return payload}
async function amapSearch(query,region,apiKey){const endpoint=new URL('https://restapi.amap.com/v3/place/text');endpoint.searchParams.set('key',apiKey);endpoint.searchParams.set('keywords',query);if(region)endpoint.searchParams.set('city',region);endpoint.searchParams.set('citylimit',region?'true':'false');endpoint.searchParams.set('offset','10');endpoint.searchParams.set('page','1');endpoint.searchParams.set('extensions','base');endpoint.searchParams.set('output','JSON');const data=assertAmap(await remoteJson(endpoint));return(data.pois||[]).map(normalizeAmapPoi).filter(Boolean)}
async function baiduSearch(query,region,apiKey){const endpoint=new URL('https://api.map.baidu.com/place/v3/suggestion');endpoint.searchParams.set('ak',apiKey);endpoint.searchParams.set('query',query);endpoint.searchParams.set('region',region||'全国');endpoint.searchParams.set('city_limit','false');endpoint.searchParams.set('output','json');endpoint.searchParams.set('ret_coordtype','gcj02ll');const data=assertBaidu(await remoteJson(endpoint));return(data.result||[]).map(normalizeBaiduPoi).filter(Boolean)}
async function amapAround(center,radius,apiKey){const endpoint=new URL('https://restapi.amap.com/v3/place/around');endpoint.searchParams.set('key',apiKey);endpoint.searchParams.set('location',`${center.lon},${center.lat}`);endpoint.searchParams.set('radius',String(radius));endpoint.searchParams.set('keywords','景点|游客中心|公共厕所|休息区|公园|博物馆|餐饮|医院|药店|公交站');endpoint.searchParams.set('sortrule','distance');endpoint.searchParams.set('offset','25');endpoint.searchParams.set('page','1');endpoint.searchParams.set('extensions','base');endpoint.searchParams.set('output','JSON');const data=assertAmap(await remoteJson(endpoint));return(data.pois||[]).map(normalizeAmapPoi).filter(Boolean)}
async function baiduAround(center,radius,apiKey){const endpoint=new URL('https://api.map.baidu.com/place/v3/around');endpoint.searchParams.set('ak',apiKey);endpoint.searchParams.set('location',`${center.lat},${center.lon}`);endpoint.searchParams.set('radius',String(radius));endpoint.searchParams.set('query','景点$游客中心$公共厕所$休息区$公园$博物馆$餐饮$医院$药店$公交站');endpoint.searchParams.set('scope','2');endpoint.searchParams.set('page_size','20');endpoint.searchParams.set('page_num','0');endpoint.searchParams.set('output','json');endpoint.searchParams.set('coord_type','gcj02ll');endpoint.searchParams.set('ret_coordtype','gcj02ll');const data=assertBaidu(await remoteJson(endpoint));return(data.results||[]).map(normalizeBaiduPoi).filter(Boolean)}
async function amapWalking(center,destination,apiKey){const endpoint=new URL('https://restapi.amap.com/v3/direction/walking');endpoint.searchParams.set('key',apiKey);endpoint.searchParams.set('origin',`${center.lon},${center.lat}`);endpoint.searchParams.set('destination',`${destination.lon},${destination.lat}`);endpoint.searchParams.set('output','JSON');const data=assertAmap(await remoteJson(endpoint)),path=data.route?.paths?.[0],points=uniqueRoutePoints((path?.steps||[]).flatMap(step=>parseRoutePath(step.polyline)));return points.length>1?{name:`步行至${destination.name}`,destinationId:destination.id,distance:numericValue(path.distance),duration:numericValue(path.duration),points}:null}
async function baiduWalking(center,destination,apiKey){const endpoint=new URL('https://api.map.baidu.com/direction/v2/walking');endpoint.searchParams.set('ak',apiKey);endpoint.searchParams.set('origin',`${center.lat},${center.lon}`);endpoint.searchParams.set('destination',`${destination.lat},${destination.lon}`);endpoint.searchParams.set('coord_type','gcj02');endpoint.searchParams.set('ret_coordtype','gcj02');endpoint.searchParams.set('output','json');const data=assertBaidu(await remoteJson(endpoint)),route=data.result?.routes?.[0],points=uniqueRoutePoints((route?.steps||[]).flatMap(step=>parseRoutePath(step.path)));return points.length>1?{name:`步行至${destination.name}`,destinationId:destination.id,distance:numericValue(route.distance),duration:numericValue(route.duration),points}:null}
async function domesticMapSearch(req,res){
  try{const body=await readJsonRequest(req),provider=String(body.provider||''),query=String(body.query||'').trim().slice(0,120),region=String(body.region||'').trim().slice(0,60),apiKey=mapApiKey(req);if(!['amap','baidu'].includes(provider))return sendJson(res,400,{error:'请选择高德地图或百度地图'});if(!query)return sendJson(res,400,{error:'请输入研究地点名称'});if(!apiKey)return sendJson(res,400,{error:'请填写地图 API Key'});const results=provider==='amap'?await amapSearch(query,region,apiKey):await baiduSearch(query,region,apiKey);return sendJson(res,200,{provider,coordinateSystem:'GCJ-02',results:results.map(item=>({placeId:item.id,name:item.name,displayName:item.address?`${item.name} · ${item.address}`:item.name,lat:item.lat,lon:item.lon,type:item.type,importance:1,provider}))})}
  catch(error){console.error('Domestic map search failed',error.message);return sendJson(res,502,{error:error.message||'国内地图地点搜索失败'})}
}
async function domesticMapContext(req,res){
  try{
    const body=await readJsonRequest(req),provider=String(body.provider||''),apiKey=mapApiKey(req),center={lat:Number(body.place?.lat),lon:Number(body.place?.lon)},radius=Math.max(100,Math.min(600,Number(body.radius)||250));
    if(!['amap','baidu'].includes(provider))return sendJson(res,400,{error:'请选择高德地图或百度地图'});if(!apiKey)return sendJson(res,400,{error:'请填写地图 API Key'});if(!Number.isFinite(center.lat)||!Number.isFinite(center.lon))return sendJson(res,400,{error:'地点坐标无效'});
    const cacheKey=`domestic:${provider}:${center.lat.toFixed(5)},${center.lon.toFixed(5)},${radius}`,cached=cachedValue(placeContextCache,cacheKey,60*60*1000);if(cached)return sendJson(res,200,cached);
    const pois=provider==='amap'?await amapAround(center,radius,apiKey):await baiduAround(center,radius,apiKey),routes=[];
    for(const destination of routeTargets(pois,center,3)){try{const route=provider==='amap'?await amapWalking(center,destination,apiKey):await baiduWalking(center,destination,apiKey);if(route)routes.push(route)}catch(error){console.warn(`${provider} walking route skipped`,error.message)}}
    const osmCenter=gcj02ToWgs84(center.lat,center.lon),query=`[out:json][timeout:32];(way(around:${radius},${osmCenter.lat},${osmCenter.lon})["building"];relation(around:${radius},${osmCenter.lat},${osmCenter.lon})["building"];way(around:${radius},${osmCenter.lat},${osmCenter.lon})["highway"];node(around:${radius},${osmCenter.lat},${osmCenter.lon})["amenity"];way(around:${radius},${osmCenter.lat},${osmCenter.lon})["amenity"];node(around:${radius},${osmCenter.lat},${osmCenter.lon})["tourism"];way(around:${radius},${osmCenter.lat},${osmCenter.lon})["tourism"];node(around:${radius},${osmCenter.lat},${osmCenter.lon})["historic"];way(around:${radius},${osmCenter.lat},${osmCenter.lon})["historic"];node(around:${radius},${osmCenter.lat},${osmCenter.lon})["barrier"];way(around:${radius},${osmCenter.lat},${osmCenter.lon})["barrier"];node(around:${radius},${osmCenter.lat},${osmCenter.lon})["natural"="tree"];node(around:${radius},${osmCenter.lat},${osmCenter.lon})["highway"="street_lamp"];way(around:${radius},${osmCenter.lat},${osmCenter.lon})["landuse"];way(around:${radius},${osmCenter.lat},${osmCenter.lon})["leisure"~"park|garden|recreation_ground"];way(around:${radius},${osmCenter.lat},${osmCenter.lon})["natural"~"water|wood|grassland"];);out center geom tags;`;
    let osmElements=[],osmError='';
    try{const osm=await loadOverpass(query);osmElements=Array.isArray(osm.elements)?osm.elements.slice(0,10000):[]}catch(error){osmError=error.message||'OSM真实几何获取失败';console.warn('Domestic OSM geometry skipped',osmError)}
    const osmBuildingCount=osmElements.filter(element=>Boolean(element.tags?.building)).length,osmRoadCount=osmElements.filter(element=>Boolean(element.tags?.highway&&element.type==='way')).length,payload={provider,coordinateSystem:'GCJ-02',center,osmCenter,radius,pois,routes,osmElements,osmAvailable:osmBuildingCount>0,osmBuildingCount,osmRoadCount,osmError:osmBuildingCount>0?'':osmError||'该范围没有可用的 OSM 真实建筑轮廓',attribution:`${provider==='amap'?'高德地图 Web 服务 API':'百度地图 Web 服务 API'}；建筑与道路 © OpenStreetMap contributors`};
    storeCache(placeContextCache,cacheKey,payload);return sendJson(res,200,payload);
  }
  catch(error){console.error('Domestic map context failed',error.message);return sendJson(res,502,{error:error.message||'国内地图空间数据获取失败'})}
}
async function searchPlaces(req,res,requestUrl){
  const query=String(requestUrl.searchParams.get('q')||'').trim().slice(0,120);if(!query)return sendJson(res,400,{error:'请输入研究地点名称'});
  const cacheKey=query.toLowerCase(),cached=cachedValue(placeSearchCache,cacheKey);if(cached)return sendJson(res,200,cached);
  try{
    const endpoint=new URL('https://nominatim.openstreetmap.org/search');endpoint.searchParams.set('q',query);endpoint.searchParams.set('format','jsonv2');endpoint.searchParams.set('limit','6');endpoint.searchParams.set('accept-language','zh-CN,zh,en');endpoint.searchParams.set('addressdetails','1');
    const text=await fetchTextWithTimeout(endpoint,{headers:{'User-Agent':'SilverTourismDigitalTwin/3.5.0 local-research-app','Accept':'application/json'}}),items=JSON.parse(text),payload={results:items.map(item=>({placeId:item.place_id,name:item.name||String(item.display_name||'').split(',')[0],displayName:item.display_name,lat:Number(item.lat),lon:Number(item.lon),type:item.type||item.addresstype||'',importance:Number(item.importance)||0,boundingBox:item.boundingbox||[]})).filter(item=>Number.isFinite(item.lat)&&Number.isFinite(item.lon)),attribution:'© OpenStreetMap contributors'};
    storeCache(placeSearchCache,cacheKey,payload);return sendJson(res,200,payload);
  }catch(error){console.error('Place search failed',error);return sendJson(res,502,{error:`地点搜索失败：${error.message}`})}
}

async function loadOverpass(query){
  const endpoints=['https://overpass.kumi.systems/api/interpreter','https://overpass-api.de/api/interpreter','https://overpass.nchc.org.tw/api/interpreter'],body=`data=${encodeURIComponent(query)}`;let lastError;
  for(const endpoint of endpoints)try{return JSON.parse(await remoteTextRequest(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},body},38000))}catch(error){lastError=error}
  throw lastError||new Error('公开地图空间查询失败');
}

async function placeContext(req,res,requestUrl){
  const lat=Number(requestUrl.searchParams.get('lat')),lon=Number(requestUrl.searchParams.get('lon')),radius=Math.max(100,Math.min(600,Number(requestUrl.searchParams.get('radius'))||250));
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return sendJson(res,400,{error:'地点坐标无效'});
  const cacheKey=`${lat.toFixed(5)},${lon.toFixed(5)},${radius}`,cached=cachedValue(placeContextCache,cacheKey,60*60*1000);if(cached)return sendJson(res,200,cached);
  const query=`[out:json][timeout:25];(way(around:${radius},${lat},${lon})["building"];way(around:${radius},${lat},${lon})["highway"];node(around:${radius},${lat},${lon})["amenity"];way(around:${radius},${lat},${lon})["amenity"];node(around:${radius},${lat},${lon})["tourism"];way(around:${radius},${lat},${lon})["tourism"];node(around:${radius},${lat},${lon})["historic"];way(around:${radius},${lat},${lon})["historic"];node(around:${radius},${lat},${lon})["barrier"];way(around:${radius},${lat},${lon})["barrier"];node(around:${radius},${lat},${lon})["natural"="tree"];node(around:${radius},${lat},${lon})["highway"="street_lamp"];);out center geom tags;`;
  try{const data=await loadOverpass(query),payload={elements:Array.isArray(data.elements)?data.elements.slice(0,4000):[],center:{lat,lon},radius,attribution:'© OpenStreetMap contributors'};storeCache(placeContextCache,cacheKey,payload);return sendJson(res,200,payload)}catch(error){console.error('Place context failed',error);return sendJson(res,502,{error:`地点空间数据获取失败：${error.message}`})}
}
const server = http.createServer(async(req,res)=>{
  const requestUrl=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&requestUrl.pathname==='/api/version'){const data=Buffer.from(JSON.stringify({name:'silver-tourism-studio',version:appVersion}));res.writeHead(200,{...headers('application/json; charset=utf-8'),'Content-Length':data.length});return res.end(data);}
  if(req.method==='GET'&&requestUrl.pathname==='/api/places/search') return searchPlaces(req,res,requestUrl);
  if(req.method==='GET'&&requestUrl.pathname==='/api/places/context') return placeContext(req,res,requestUrl);
  if(req.method==='POST'&&requestUrl.pathname==='/api/domestic-map/search') return domesticMapSearch(req,res);
  if(req.method==='POST'&&requestUrl.pathname==='/api/domestic-map/context') return domesticMapContext(req,res);
  if(req.method==='POST'&&req.url==='/api/figures') return figures(req,res);
  if(req.method==='POST'&&req.url==='/api/llm-strategy') return llmStrategy(req,res);
  if(req.method==='POST'&&req.url==='/api/analyze-scene-images') return analyzeSceneImages(req,res);
  if(req.method==='POST'&&req.url==='/api/worldlabs/start') return startWorldGeneration(req,res);
  if(req.method==='POST'&&req.url==='/api/worldlabs/poll') return pollWorldGeneration(req,res);
  if(req.method==='POST'&&req.url==='/api/worldlabs/cache-quality') return cacheWorldQuality(req,res);
  if(req.method==='POST'&&req.url.startsWith('/api/upload-scene')) return uploadScene(req,res);
  try {
    const safe=decodeURIComponent(requestUrl.pathname).replace(/^\/+/,''),candidate=path.resolve(root,safe||'dist/index.html');
    if(!candidate.startsWith(root))throw new Error('Forbidden');
    let file=candidate;
    try{const info=await stat(file);if(info.isDirectory())file=path.join(file,'index.html')}catch{file=path.join(root,'dist',safe||'index.html')}
    const data=await readFile(file);res.writeHead(200,{...headers(mime[path.extname(file)]||'application/octet-stream'),'Content-Length':data.length});res.end(data);
  } catch(error) { res.writeHead(404,headers('text/plain; charset=utf-8'));res.end('Not found'); }
});
server.listen(port,'127.0.0.1',()=>console.log(`Silver Tourism Digital Twin Studio: http://127.0.0.1:${port}`));




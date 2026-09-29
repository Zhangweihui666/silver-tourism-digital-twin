# Security Policy

## Sensitive data

本项目支持地图与模型服务 API Key，以及照片、轨迹和三维场景上传。请遵循以下原则：

- 不要把任何真实 API Key、`.env`、访问令牌或个人凭据提交到 Git。
- 不要公开包含可识别个人、精确行动轨迹或未授权现场影像的数据。
- 只向可信的 HTTPS 模型接口发送数据；本机 `localhost` 调试除外。
- `uploads/` 是本地运行目录，已在 `.gitignore` 中排除。

## Reporting a vulnerability

请不要在公开 Issue 中披露可被直接利用的漏洞。优先通过 GitHub Security Advisory 私下报告，并提供影响范围、复现步骤和建议修复方式。请勿在报告中包含真实密钥或第三方个人数据。


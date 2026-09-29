$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    $requestData = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $payload = $requestData.payload | ConvertTo-Json -Depth 30 -Compress
    $headers = @{ Authorization = "Bearer $($requestData.apiKey)" }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $requestData.endpoint -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 90
        @{ ok = $true; status = [int]$response.StatusCode; body = [string]$response.Content } | ConvertTo-Json -Compress -Depth 10
    } catch {
        $status = 0
        $body = ''
        if ($_.Exception.Response) {
            try { $status = [int]$_.Exception.Response.StatusCode } catch {}
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                if ($stream) { $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8); $body = $reader.ReadToEnd(); $reader.Dispose() }
            } catch {}
        }
        if ($status -gt 0) { @{ ok = $false; status = $status; body = $body } | ConvertTo-Json -Compress -Depth 10 }
        else { @{ networkError = "PowerShell 网络回退失败：$($_.Exception.Message)" } | ConvertTo-Json -Compress -Depth 10 }
    }
} catch {
    @{ networkError = "PowerShell 代理执行失败：$($_.Exception.Message)" } | ConvertTo-Json -Compress -Depth 10
}

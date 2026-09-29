import json
import sys
import urllib.error
import urllib.request


def main():
    request_data = json.load(sys.stdin)
    endpoint = request_data["endpoint"]
    payload = json.dumps(request_data["payload"], ensure_ascii=False).encode("utf-8", errors="replace")
    request = urllib.request.Request(
        endpoint,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {request_data['apiKey']}",
            "User-Agent": "SilverTourismWeb/2.5",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            body = response.read().decode("utf-8", errors="replace")
            json.dump({"ok": 200 <= response.status < 300, "status": response.status, "body": body}, sys.stdout, ensure_ascii=False)
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        json.dump({"ok": False, "status": error.code, "body": body}, sys.stdout, ensure_ascii=False)
    except Exception as error:
        if getattr(error, "winerror", None) == 10013 or "10013" in str(error):
            message = "Windows 网络权限阻止连接（WinError 10013）。请在防火墙中允许 node.exe 和 python.exe 访问 HTTPS，然后重新启动应用。"
        else:
            message = f"{type(error).__name__}: {error}"
        json.dump({"networkError": message}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()

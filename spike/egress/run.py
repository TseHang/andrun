"""Run after pnpm exec wrangler dev --config spike/egress/wrangler.jsonc --port 8791."""
import json
from pathlib import Path
from urllib.request import urlopen

output = Path(__file__).parent / "evidence"
output.mkdir(exist_ok=True)
for name in ["start", "env", "trust", "curl", "http", "post", "node-plain", "node-env", "npm", "port", "search", "restart", "trust", "curl", "post", "node-env", "npm", "offline"]:
    url = "http://localhost:8791/" + name + ("?s=offline" if name == "offline" else "")
    try:
        with urlopen(url, timeout=150) as response:
            result = response.read().decode()
    except Exception as error:
        result = json.dumps({"error": str(error)})
    previous = list(output.glob(name + "*.json"))
    suffix = "-" + str(len(previous) + 1) if previous else ""
    (output / (name + suffix + ".json")).write_text(result + "\n")
    print(name, result, flush=True)

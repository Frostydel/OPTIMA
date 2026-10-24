import os, sys, time, threading, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import main, uvicorn
from fastapi import Request

state = {"calls": [], "active": 0, "max_active": 0, "fail": None}
lock = threading.Lock()

class FakeModels:
    def generate_content(self, **kw):
        with lock:
            state["active"] += 1
            state["max_active"] = max(state["max_active"], state["active"])
            n = len(state["calls"]); state["calls"].append(kw["contents"][1])
        time.sleep(0.8)
        with lock: state["active"] -= 1
        class R:
            # every 3rd answer repeats the previous one -> exercises de-duplication
            text = f"Test description number {n - (n % 3 == 2)}."
            candidates = []
        return R()
class FakeClient: models = FakeModels()
main.analyze_image.__globals__["_get_client"] = lambda: FakeClient()

@main.app.get("/_state")
def _state(): return {k: v for k, v in state.items() if k != "calls"} | {"n": len(state["calls"]), "prompts": state["calls"]}
@main.app.post("/_reset")
def _reset():
    state.update(calls=[], active=0, max_active=0); return {}
# routes added after the static mount would be shadowed, so move the mount last
routes = main.app.router.routes
mount = [r for r in routes if getattr(r, "name", "") == "static"][0]
routes.remove(mount); routes.append(mount)
uvicorn.run(main.app, port=8765, log_level="warning")

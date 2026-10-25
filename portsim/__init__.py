"""PortSim SFT loop: data prep, grading, eval and training around the vendored FineEnvs checker."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_TP = ROOT / "third_party"
if str(_TP) not in sys.path:
    sys.path.insert(0, str(_TP))  # makes `import berth_core` work without installing it

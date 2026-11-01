import torch
from . import config, settings

def pick():
    """CPU when the household said so (GPU power: don't use the GPU), else
    DEVICE, else the first card found: Intel (XPU), then CUDA (NVIDIA, and
    AMD through ROCm), then the CPU."""
    if settings.rule("power") == "cpu":
        return "cpu"
    d = config.DEVICE
    if d != "auto":
        return d
    if hasattr(torch, "xpu") and torch.xpu.is_available():
        return "xpu"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"

def sync(dev):
    if dev == "xpu":
        torch.xpu.synchronize()
    elif dev == "cuda":
        torch.cuda.synchronize()

def free_cache():
    try:
        if hasattr(torch, "xpu") and torch.xpu.is_available():
            torch.xpu.empty_cache()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass

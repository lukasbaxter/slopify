import torch
from . import config

def pick():
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

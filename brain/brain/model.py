import torch, torch.nn as nn, torch.nn.functional as F
from .features import N_CTX, N_STEP

class Brain(nn.Module):
    """Items: sound (CLAP) + artist + own id (songs with plays). Listener:
    their last plays through a small transformer, plus who they are and the
    moment (time, weather, device, mode). Score = cosine of the two."""
    def __init__(self, n_items, n_artists, n_users, d=128, audio_dim=512, max_len=64):
        super().__init__()
        self.audio = nn.Sequential(nn.Linear(audio_dim, 256), nn.GELU(), nn.Linear(256, d))
        self.artist = nn.Embedding(n_artists + 1, d, padding_idx=0)
        self.item = nn.Embedding(n_items + 1, d, padding_idx=0)
        self.mix = nn.Linear(3 * d, d)
        self.pos = nn.Embedding(max_len, d)
        self.step = nn.Linear(N_STEP + N_CTX, d)
        layer = nn.TransformerEncoderLayer(d, 4, 4 * d, dropout=0.1, batch_first=True, norm_first=True)
        self.enc = nn.TransformerEncoder(layer, 2)
        self.user = nn.Embedding(n_users + 1, d, padding_idx=0)
        self.ctx = nn.Sequential(nn.Linear(N_CTX, d), nn.GELU(), nn.Linear(d, d))
        self.head = nn.Sequential(nn.Linear(3 * d, 2 * d), nn.GELU(), nn.Linear(2 * d, d))
        self.max_len = max_len
        nn.init.normal_(self.item.weight, std=0.01); nn.init.normal_(self.artist.weight, std=0.02)

    def items(self, audio, artist_idx, own_idx):
        """audio [N,512], artist_idx [N], own_idx [N] (0 = no own vector) -> [N,d] unit vectors."""
        x = torch.cat([self.audio(audio), self.artist(artist_idx), self.item(own_idx)], -1)
        return F.normalize(self.mix(x), dim=-1)

    def query(self, hist_vecs, hist_feats, mask, user_idx, ctx):
        """hist_vecs [B,L,d] (item vectors), hist_feats [B,L,N_STEP+N_CTX], mask [B,L] True = padding,
        user_idx [B], ctx [B,N_CTX] -> [B,d] unit vectors."""
        B, L, _ = hist_vecs.shape
        pos = self.pos(torch.arange(L, device=hist_vecs.device))[None]
        h = hist_vecs + self.step(hist_feats) + pos
        h = self.enc(h, src_key_padding_mask=mask)
        last = (~mask).sum(1).clamp(min=1) - 1           # newest step (left-aligned history)
        hl = h[torch.arange(B), last] * (~mask).any(1, keepdim=True)
        return F.normalize(self.head(torch.cat([hl, self.user(user_idx), self.ctx(ctx)], -1)), dim=-1)

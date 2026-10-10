"""Panel detection with Magi v2 (Hugging Face: ragavsachdeva/magiv2).

Magi is trained on manga and orders panels right-to-left; for Western comics we re-sort
its boxes into rows read left to right.
"""

import threading
from functools import cache
from pathlib import Path

import numpy as np
import torch
from PIL import Image

MODEL_ID = "ragavsachdeva/magiv2"
_lock = threading.Lock()  # one page at a time through the model


def device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


@cache
def model():
    from transformers import AutoModel

    return AutoModel.from_pretrained(MODEL_ID, trust_remote_code=True).to(device()).eval()


def detect(page: Image.Image, rtl: bool = False) -> list[dict]:
    """Return panels in reading order: [{bbox: [x1,y1,x2,y2], characters: [cluster ids]}]."""
    img = page.convert("L").convert("RGB")
    with _lock, torch.no_grad():
        r = model().predict_detections_and_associations([np.array(img)])[0]

    boxes = [[round(v) for v in b] for b in r["panels"]]  # Magi's order is manga (right-to-left)
    if not rtl:
        boxes = western_order(boxes)
    panels = [{"bbox": b, "characters": []} for b in boxes]
    # Same cluster id = Magi thinks it's the same person (used as a hint for consistent voices).
    for box, label in zip(r["characters"], r["character_cluster_labels"]):
        cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        for p in panels:
            x1, y1, x2, y2 = p["bbox"]
            if x1 <= cx <= x2 and y1 <= cy <= y2:
                p["characters"].append(int(label))
                break
    return panels


def western_order(boxes: list[list[int]]) -> list[list[int]]:
    """Group panels into rows by vertical overlap, then read each row left to right.

    Gutters in old comics rarely line up exactly, so a panel joins the current row when at
    least half its height overlaps the row's band. A tall panel spanning two rows pulls the
    stacked panels beside it into its row, which is the Western reading order for that layout.
    """
    rows: list[list[list[int]]] = []
    band = (0, 0)
    for b in sorted(boxes, key=lambda b: b[1]):
        overlap = min(b[3], band[1]) - max(b[1], band[0])
        if rows and overlap >= 0.5 * (b[3] - b[1]):
            rows[-1].append(b)
            band = (min(band[0], b[1]), max(band[1], b[3]))
        else:
            rows.append([b])
            band = (b[1], b[3])
    return [b for row in rows for b in sorted(row, key=lambda b: (b[0], b[1]))]


def crop(page: Image.Image, bbox: list[int], pad: int = 4) -> Image.Image:
    x1, y1, x2, y2 = bbox
    return page.crop((max(0, x1 - pad), max(0, y1 - pad), min(page.width, x2 + pad), min(page.height, y2 + pad)))


if __name__ == "__main__":
    # Debug: uv run python -m api.panels page.jpg [--rtl]  → writes page.panels.png with numbered boxes
    import sys

    from PIL import ImageDraw

    path = Path(sys.argv[1])
    page = Image.open(path).convert("RGB")
    found = detect(page, rtl="--rtl" in sys.argv)
    draw = ImageDraw.Draw(page)
    for i, p in enumerate(found, 1):
        draw.rectangle(p["bbox"], outline=(255, 0, 0), width=6)
        draw.text((p["bbox"][0] + 12, p["bbox"][1] + 8), str(i), fill=(255, 0, 0), font_size=64)
        print(i, p)
    out = path.with_suffix(".panels.png")
    page.save(out)
    print("wrote", out)

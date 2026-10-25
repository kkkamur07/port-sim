"""LoRA SFT of the base model on data/sft.jsonl, driven by recipe.json. Runs on the GPU box.

    CUDA_VISIBLE_DEVICES=0 python -m portsim.train_sft --run loop1 --data data/sft.jsonl

Saves the merged model to models/<run>/ so vLLM can serve it directly.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import torch
from datasets import load_dataset
from peft import LoraConfig
from transformers import AutoTokenizer
from trl import SFTConfig, SFTTrainer

from portsim import ROOT

TARGETS = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]


def load_model(name: str):
    """Qwen3.5 checkpoints are vision-language models; we only train the language model."""
    from transformers import AutoModelForCausalLM
    try:
        return AutoModelForCausalLM.from_pretrained(name, dtype=torch.bfloat16, attn_implementation="sdpa")
    except Exception as e:  # fall back to the multimodal class and train it text-only
        print(f"AutoModelForCausalLM failed ({e!r}); loading the multimodal class")
        from transformers import AutoModelForImageTextToText
        return AutoModelForImageTextToText.from_pretrained(name, dtype=torch.bfloat16, attn_implementation="sdpa")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--data", default=str(ROOT / "data" / "sft.jsonl"))
    ap.add_argument("--recipe", default=str(ROOT / "portsim" / "recipe.json"))
    ap.add_argument("--base", default=None, help="override the base model (e.g. a previous loop's merged model)")
    args = ap.parse_args()
    recipe = json.loads(Path(args.recipe).read_text())
    tr = recipe["train"]
    base = args.base or recipe["base_model"]
    out_dir = ROOT / "models" / args.run
    log_dir = ROOT / "runs" / args.run
    log_dir.mkdir(parents=True, exist_ok=True)

    tok = AutoTokenizer.from_pretrained(base)
    ds = load_dataset("json", data_files=args.data, split="train")
    ds = ds.remove_columns([c for c in ds.column_names if c != "messages"])
    model = load_model(base)

    peft_cfg = LoraConfig(r=tr["lora_rank"], lora_alpha=tr["lora_alpha"], lora_dropout=0.0, bias="none",
                          target_modules=TARGETS, task_type="CAUSAL_LM")
    cfg = SFTConfig(
        output_dir=str(out_dir / "checkpoints"),
        num_train_epochs=tr["epochs"], learning_rate=tr["learning_rate"], lr_scheduler_type="cosine",
        warmup_ratio=tr["warmup_ratio"], per_device_train_batch_size=tr["per_device_batch"],
        gradient_accumulation_steps=tr["grad_accum"], max_length=tr["max_seq_len"],
        bf16=True, gradient_checkpointing=True, logging_steps=5, save_strategy="no", report_to="trackio",
        run_name=args.run, assistant_only_loss=True, packing=False,
    )
    trainer = SFTTrainer(model=model, args=cfg, train_dataset=ds, processing_class=tok, peft_config=peft_cfg)
    t0 = time.time()
    result = trainer.train()
    merged = trainer.model.merge_and_unload()
    merged.save_pretrained(out_dir, safe_serialization=True)
    tok.save_pretrained(out_dir)
    # vLLM needs the processor files of the multimodal checkpoint next to the weights
    try:
        from transformers import AutoProcessor
        AutoProcessor.from_pretrained(base).save_pretrained(out_dir)
    except Exception as e:
        print(f"no processor saved: {e!r}")
    log = {"run": args.run, "base": base, "examples": len(ds), "train_loss": result.training_loss,
           "minutes": round((time.time() - t0) / 60, 1), "history": trainer.state.log_history, "recipe": recipe}
    (log_dir / "train.json").write_text(json.dumps(log, indent=1))
    print(json.dumps({k: v for k, v in log.items() if k != "history"}, indent=1))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
PlateQ — PP-OCR ONNX Recognition Engine Model & Dictionary Exporter
====================================================================
Downloads the PP-OCR recognition ONNX model (ch_PP-OCRv4_rec.onnx)
and character dictionary into public/models/ for zero-latency local
browser inference via onnxruntime-web (WebGPU/WASM).
"""

import os
import sys
import urllib.request

MODELS_DIR = "public/models"
DICT_FILE = os.path.join(MODELS_DIR, "ppocr-dict.txt")
MODEL_FILE = os.path.join(MODELS_DIR, "ppocr-rec.onnx")

DICT_URL = "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/ppocr_keys_v1.txt"
MODEL_URL = "https://huggingface.co/OleehyO/paddleocrv4.onnx/resolve/main/ch_PP-OCRv4_rec.onnx"

def patch_model_for_browser_runtime(model_file: str) -> None:
    """
    The upstream PP-OCR model is FP16 internally but advertises FP32 I/O in
    places that make ONNX Runtime Web reject the graph. Keep the public API as
    FP32, cast into FP16 for the model body, strip stale value_info metadata,
    and cast the final softmax back to FP32 for the JS decoder.
    """
    try:
        import onnx
        from onnx import TensorProto, helper
    except ImportError:
        print("      Error: onnx is required to patch the PP-OCR browser graph.")
        print("      Install with: python3 -m pip install onnx")
        sys.exit(1)

    model = onnx.load(model_file)

    has_fp16_constants = any(
        node.op_type == "Constant"
        and any(
            attr.name == "value"
            and attr.HasField("t")
            and attr.t.data_type == TensorProto.FLOAT16
            for attr in node.attribute
        )
        for node in model.graph.node
    )
    if not has_fp16_constants:
        print("      Browser patch skipped: model does not use FP16 constants.")
        return

    input_name = model.graph.input[0].name
    input_cast_node_name = "PlateQ_InputFloat32ToFloat16"
    if (
        model.graph.input[0].type.tensor_type.elem_type == TensorProto.FLOAT
        and not any(node.name == input_cast_node_name for node in model.graph.node)
    ):
        cast_output = f"{input_name}_fp16"
        redirected = 0
        for node in model.graph.node:
            for idx, node_input in enumerate(node.input):
                if node_input == input_name:
                    node.input[idx] = cast_output
                    redirected += 1

        model.graph.node.insert(
            0,
            helper.make_node(
                "Cast",
                inputs=[input_name],
                outputs=[cast_output],
                name=input_cast_node_name,
                to=TensorProto.FLOAT16,
            ),
        )
        print(f"      Patched input: {input_name} FP32 -> FP16 ({redirected} use)")

    del model.graph.value_info[:]

    output_name = model.graph.output[0].name
    output_cast_node_name = "PlateQ_OutputFloat16ToFloat32"
    if (
        model.graph.output[0].type.tensor_type.elem_type == TensorProto.FLOAT
        and not any(node.name == output_cast_node_name for node in model.graph.node)
    ):
        internal_output = f"{output_name}_fp16"
        producer_found = False
        for node in model.graph.node:
            for idx, node_output in enumerate(node.output):
                if node_output == output_name:
                    node.output[idx] = internal_output
                    producer_found = True
                    break
            if producer_found:
                break

        if producer_found:
            model.graph.node.append(
                helper.make_node(
                    "Cast",
                    inputs=[internal_output],
                    outputs=[output_name],
                    name=output_cast_node_name,
                    to=TensorProto.FLOAT,
                ),
            )
            print(f"      Patched output: {output_name} FP16 -> FP32")

    onnx.checker.check_model(model)
    onnx.save(model, model_file)

def main():
    print("=" * 65)
    print("  PlateQ — PP-OCR Recognition Engine Setup")
    print("=" * 65)

    os.makedirs(MODELS_DIR, exist_ok=True)

    # 1. Download Dictionary
    print("\n[1/2] Fetching character dictionary (ppocr_keys_v1.txt) ...")
    try:
        urllib.request.urlretrieve(DICT_URL, DICT_FILE)
        lines = len(open(DICT_FILE, encoding="utf-8").readlines())
        print(f"      Saved: {DICT_FILE} ({lines} characters)")
    except Exception as e:
        print(f"      Error fetching dictionary: {e}")
        sys.exit(1)

    # 2. Download ONNX Model
    print("\n[2/2] Fetching PP-OCRv4 Recognition ONNX Model ...")
    try:
        urllib.request.urlretrieve(MODEL_URL, MODEL_FILE)
        print("      Applying ONNX Runtime Web compatibility patch ...")
        patch_model_for_browser_runtime(MODEL_FILE)
        size_mb = os.path.getsize(MODEL_FILE) / 1024 / 1024
        print(f"      Saved: {MODEL_FILE} ({size_mb:.2f} MB)")
    except Exception as e:
        print(f"      Error fetching ONNX model: {e}")
        sys.exit(1)

    print(f"\n{'=' * 65}")
    print("  ✅ PP-OCR ONNX Recognition Engine setup complete!")
    print(f"  Model Path : {MODEL_FILE}")
    print(f"  Dict Path  : {DICT_FILE}")
    print(f"  Execution  : Browser ONNX Runtime Web (WebGPU -> WASM)")
    print(f"{'=' * 65}\n")

if __name__ == "__main__":
    main()

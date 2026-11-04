"""Two-line handwriting experiment. Network access is used only by --download."""
import argparse
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODEL_SPEC = json.loads((ROOT / 'scripts' / 'handwriting-model.json').read_text(encoding='utf8'))
MODEL_ID = MODEL_SPEC['id']
REVISION = MODEL_SPEC['revision']
MODEL_DIR = ROOT / 'rejections' / 'models' / 'trocr-base-handwritten'


def download():
    from huggingface_hub import snapshot_download
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    snapshot_download(repo_id=MODEL_ID, revision=REVISION, local_dir=MODEL_DIR,
                      allow_patterns=['*.json', 'merges.txt', 'vocab.json', 'model.safetensors'])
    (MODEL_DIR / 'source.json').write_text(json.dumps({'model': MODEL_ID, 'revision': REVISION}), encoding='utf8')
    print('Downloaded pinned handwriting model:', MODEL_DIR)


def recognize(manifest_path, output_path):
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    import torch
    from PIL import Image, ImageOps, ImageEnhance
    from transformers import TrOCRProcessor, VisionEncoderDecoderModel
    from handwriting_preprocess import split_header

    source = json.loads((MODEL_DIR / 'source.json').read_text(encoding='utf8'))
    if source.get('revision') != REVISION:
        raise ValueError('Unexpected model revision. Rerun Setup Handwriting OCR.cmd.')
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    processor = TrOCRProcessor.from_pretrained(MODEL_DIR, local_files_only=True, use_fast=False)
    model = VisionEncoderDecoderModel.from_pretrained(MODEL_DIR, local_files_only=True, use_safetensors=True)
    model.eval()
    manifest = json.loads(Path(manifest_path).read_text(encoding='utf8'))
    results = []
    headers = {}
    allowed_tokens = {}
    for field, alphabet in [('Ack. No', set('0123456789 \t\n')), ('Ack Date', set('0123456789-./ \t\n'))]:
        permitted = []
        for token in range(len(processor.tokenizer)):
            if token in processor.tokenizer.all_special_ids:
                continue
            decoded = processor.tokenizer.decode([token])
            if decoded and all(character in alphabet for character in decoded):
                permitted.append(token)
        permitted.append(processor.tokenizer.eos_token_id)
        allowed_tokens[field] = permitted
    for item in manifest['images']:
        segmentation = None
        selected_path = item['path']
        if item.get('headerPath'):
            if item['headerPath'] not in headers:
                try:
                    headers[item['headerPath']] = split_header(item['headerPath'], Path(output_path).parent)
                except Exception as error:
                    headers[item['headerPath']] = {'error': str(error)}
            segmentation = headers[item['headerPath']]
            if 'error' not in segmentation:
                selected_path = segmentation['number' if item['field']=='Ack. No' else 'date']
        original = Image.open(selected_path).convert('RGB')
        enhanced = ImageEnhance.Contrast(ImageOps.autocontrast(ImageOps.grayscale(original))).enhance(1.5).convert('RGB')
        readings = []
        for variant, image in [('original', original), ('contrast', enhanced)]:
            values = processor(images=image, return_tensors='pt').pixel_values
            with torch.inference_mode():
                generated = model.generate(values, max_new_tokens=32, num_beams=2,
                                           return_dict_in_generate=True, output_scores=True,
                                           prefix_allowed_tokens_fn=lambda _batch, _ids: allowed_tokens[item['field']])
            text = processor.batch_decode(generated.sequences, skip_special_tokens=True)[0]
            readings.append({'variant': variant, 'text': text,
                             'sequenceScore': float(generated.sequences_scores[0])})
        results.append({**item, 'processedPath': selected_path, 'segmentation': segmentation,
                        'decoder': 'digits and whitespace only' if item['field']=='Ack. No' else 'digits, date separators and whitespace only',
                        'readings': readings})
        Path(output_path).write_text(json.dumps({'model': MODEL_ID, 'revision': REVISION,
            'offline': True, 'results': results,
            'note': 'Variants use the same model; consistency is not independent verification and sequence scores are not calibrated accuracy.'}, indent=2), encoding='utf8')
        print('Read local crop:', item['page'], item['field'], json.dumps(readings), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--manifest')
    parser.add_argument('--output')
    args = parser.parse_args()
    if args.download:
        download()
    elif args.manifest and args.output:
        recognize(args.manifest, args.output)
    else:
        parser.error('Use --download or --manifest FILE --output FILE')


if __name__ == '__main__':
    main()

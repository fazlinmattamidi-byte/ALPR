#!/usr/bin/env python3
"""Exercise all four shipped ONNX models on video samples.

Diagnostic only: OpenCV photometric recovery approximates browser processing;
OCR confidence comparisons are not ground-truth accuracy or browser timing.
"""
import json
from collections import Counter
from pathlib import Path
import cv2
import numpy as np
import onnxruntime as ort
from benchmark_training_videos import Detector, Ocr, ROOT, VIDEO_DIR


def classifier(name):
    metadata = json.loads((ROOT / 'public/models' / f'{name}.metadata.json').read_text())
    session = ort.InferenceSession(str(ROOT / 'public/models' / f'{name}.onnx'), providers=['CPUExecutionProvider'])
    return session, metadata


def classify(model, frame):
    session, metadata = model
    if metadata.get('resizeMode') == 'letterbox':
        h, w = frame.shape[:2]
        scale = min(224/w, 224/h)
        rw, rh = max(1, round(w*scale)), max(1, round(h*scale))
        image = np.full((224, 224, 3), 114, dtype=np.uint8)
        x, y = (224-rw)//2, (224-rh)//2
        image[y:y+rh, x:x+rw] = cv2.resize(frame, (rw, rh))
    else:
        image = cv2.resize(frame, (224, 224))
    tensor = image[:, :, ::-1].astype(np.float32).transpose(2, 0, 1)[None] / 255
    output = session.run(None, {session.get_inputs()[0].name: tensor})[0].flatten()
    if abs(float(output.sum())-1) > .25 or output.min() < 0:
        output = np.exp(output-output.max()); output /= output.sum()
    index = int(output.argmax())
    return metadata['classes'][index], round(float(output[index]), 4)


def enhance(frame, variant):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    if variant == 'GAMMA_BRIGHTEN':
        gray = np.round(255*(gray.astype(np.float32)/255)**.68).astype(np.uint8)
    elif variant == 'HIGHLIGHT_REDUCED':
        values = gray.astype(np.float32)/255
        gray = np.round(np.clip(np.where(values>.7, .7+(values-.7)*.45, values)*1.08, 0, 1)*255).astype(np.uint8)
    elif variant == 'SHARPEN':
        gray = cv2.filter2D(gray, -1, np.array([[0,-1,0],[-1,5,-1],[0,-1,0]]))
    else:
        gray = cv2.createCLAHE(clipLimit=2, tileGridSize=(8,8)).apply(gray)
    return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)


def main():
    detector, ocr = Detector(), Ocr()
    environment = classifier('environment-classifier')
    quality = classifier('plate-quality-classifier')
    results = []
    for path in sorted(VIDEO_DIR.glob('*.mp4')):
        cap = cv2.VideoCapture(str(path))
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        step = max(1, round(fps/3))
        environments, qualities = Counter(), Counter()
        row = {'video': path.name, 'frames': 0, 'rawDetectionFrames': 0, 'recoveredDetectionFrames': 0, 'crops': []}
        index = 0
        while True:
            ok, frame = cap.read()
            if not ok: break
            index += 1
            if (index-1) % step: continue
            row['frames'] += 1
            label, confidence = classify(environment, frame)
            environments[label] += 1
            boxes, _ = detector.detect(frame, .24)
            row['rawDetectionFrames'] += bool(boxes)
            if not boxes:
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                brightness, glare = float(gray.mean()/255), float((gray > 242).mean())
                variant = 'HIGHLIGHT_REDUCED' if glare >= .10 else 'GAMMA_BRIGHTEN' if brightness <= .30 else 'GAMMA_BRIGHTEN' if label in ['NIGHT','LOW_LIGHT','TUNNEL'] else 'HIGHLIGHT_REDUCED' if label in ['GLARE','BACKLIGHT'] else 'CLAHE'
                recovered, _ = detector.detect(enhance(frame, variant), .24)
                if recovered: row['recoveredDetectionFrames'] += 1
                boxes = recovered
            for x1,y1,x2,y2,_ in boxes:
                crop = frame[max(0,int(y1)):int(y2),max(0,int(x1)):int(x2)]
                if not crop.size: continue
                qlabel, qconfidence = classify(quality, crop)
                qualities[qlabel] += 1
                raw, raw_conf, _ = ocr.recognize_plate(crop)
                variant = 'SHARPEN' if qlabel in ['MOTION_BLUR','OUT_OF_FOCUS'] else 'HIGHLIGHT_REDUCED' if qlabel in ['GLARE_REFLECTION','OVEREXPOSED'] else 'GAMMA_BRIGHTEN' if qlabel == 'UNDEREXPOSED' else 'CLAHE'
                corrected, corrected_conf, _ = ocr.recognize_plate(enhance(crop, variant))
                row['crops'].append({'seconds': round((index-1)/fps,3), 'quality': qlabel, 'qualityConfidence': qconfidence, 'variant': variant, 'raw': raw, 'rawConfidence': round(raw_conf,4), 'enhanced': corrected, 'enhancedConfidence': round(corrected_conf,4)})
        cap.release()
        row['environmentClasses'] = dict(environments); row['qualityClasses'] = dict(qualities)
        results.append(row)
        print(path.name, row['rawDetectionFrames'], row['recoveredDetectionFrames'], dict(qualities), flush=True)
    output = {'scope': 'All four shipped ONNX models; 3 fps offline diagnostic; OpenCV recovery approximation; not labelled accuracy or browser latency. Angle rectification is covered by TypeScript routing tests, not this Python diagnostic.', 'results': results}
    (ROOT/'reports/condition-model-diagnostic.json').write_text(json.dumps(output, indent=2)+'\n')

if __name__ == '__main__': main()

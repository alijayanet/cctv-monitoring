import os
import sys
import time
import json
import math
import threading
import urllib.request
import warnings
import requests
import cv2
import numpy as np

# Suppress PyTorch/OpenCV/YOLO verbose warnings (e.g., NNPACK hardware fallback)
os.environ["PYTHONWARNINGS"] = "ignore"
os.environ["YOLO_VERBOSE"] = "False"
warnings.filterwarnings("ignore")

try:
    import torch
    torch.set_num_threads(1)  # Restrict to 1 thread per camera to prevent 100% CPU spike
    torch.set_grad_enabled(False)
except Exception:
    pass

try:
    from ultralytics import YOLO
except ImportError:
    print("[AI ENGINE] Error: 'ultralytics' library is not installed.")
    sys.exit(1)

BASE_URL = os.environ.get("SERVER_BASE_URL", "http://127.0.0.1:3003")
MODEL_FILENAME = "yolov8n.pt"
MODEL_URL = "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n.pt"

# Target COCO Classes
TARGET_CLASSES = {
    0: "person",
    2: "car",
    3: "motorcycle",
    5: "truck",  # bus -> truck
    7: "truck"
}

def ensure_model():
    model_path = os.path.join(os.path.dirname(__file__), MODEL_FILENAME)
    if not os.path.exists(model_path):
        print(f"[AI ENGINE] Downloading lightweight YOLO model ({MODEL_FILENAME})...")
        try:
            urllib.request.urlretrieve(MODEL_URL, model_path)
            print("[AI ENGINE] Model downloaded successfully!")
        except Exception as e:
            print(f"[AI ERR] Failed to download model: {e}")
            return None
    return model_path

# Global State
active_threads = {}
running = True

def ccw(A, B, C):
    return (C[1] - A[1]) * (B[0] - A[0]) > (B[1] - A[1]) * (C[0] - A[0])

def segments_intersect(A, B, C, D):
    return (ccw(A, C, D) != ccw(B, C, D)) and (ccw(A, B, C) != ccw(A, B, D))

def get_line_side(p, line_p1, line_p2):
    return (line_p2[0] - line_p1[0]) * (p[1] - line_p1[1]) - (line_p2[1] - line_p1[1]) * (p[0] - line_p1[0])

def send_count_event(camera_id, class_name, direction):
    try:
        url = f"{BASE_URL}/api/ai/count-event"
        payload = {
            "camera_id": camera_id,
            "class_name": class_name,
            "direction": direction
        }
        res = requests.post(url, json=payload, timeout=3)
        if res.status_code == 200:
            print(f"[AI COUNT ✅] Cam #{camera_id}: +1 {class_name.upper()} ({direction.upper()})")
    except Exception as e:
        print(f"[AI ERR] Failed to send count event: {e}")

def process_camera_stream(cam_config, model_path):
    cam_id = cam_config["id"]
    cam_name = cam_config["nama"]
    rtsp_url = cam_config["url_rtsp"]
    
    line_coords = cam_config.get("ai_line_coords", {})
    if isinstance(line_coords, str):
        try:
            line_coords = json.loads(line_coords)
        except Exception:
            line_coords = {"x1": 0.1, "y1": 0.5, "x2": 0.9, "y2": 0.5}
            
    lx1 = line_coords.get("x1", 0.1)
    ly1 = line_coords.get("y1", 0.5)
    lx2 = line_coords.get("x2", 0.9)
    ly2 = line_coords.get("y2", 0.5)

    print(f"[AI ENGINE] Starting High-Precision ByteTrack Counter for {cam_name} (#{cam_id})...")
    
    model = YOLO(model_path)

    cap = cv2.VideoCapture(rtsp_url)
    if not cap.isOpened():
        print(f"[AI ERR] Cannot connect to RTSP stream for Camera #{cam_id}")
        return

    snap_dir = os.path.join(os.path.dirname(__file__), "public", "ai_snaps")
    os.makedirs(snap_dir, exist_ok=True)
    snap_path = os.path.join(snap_dir, f"cam_{cam_id}.jpg")

    track_positions = {}   # { track_id: (cx, cy) }
    counted_ids = set()    # { track_id }
    frame_counter = 0

    while running and cam_id in active_threads and active_threads[cam_id]["active"]:
        ret, frame = cap.read()
        if not ret:
            print(f"[AI WARN] Stream lost for Camera #{cam_id}. Retrying in 5s...")
            time.sleep(5)
            cap = cv2.VideoCapture(rtsp_url)
            continue

        frame_counter += 1
        if frame_counter % 2 != 0:  # Sample every 2nd frame
            time.sleep(0.02)
            continue

        h, w = frame.shape[:2]
        p1 = (int(lx1 * w), int(ly1 * h))
        p2 = (int(lx2 * w), int(ly2 * h))

        # Run ByteTrack Tracking with imgsz=320 (Lightweight & Low CPU)
        try:
            results = model.track(frame, persist=True, tracker="bytetrack.yaml", conf=0.20, imgsz=320, verbose=False)
        except Exception as err:
            results = model.predict(frame, conf=0.20, imgsz=320, verbose=False)

        time.sleep(0.03)  # Yield CPU to prevent 100% core saturation

        current_track_ids = set()

        if results and len(results) > 0 and results[0].boxes is not None:
            boxes = results[0].boxes
            cls_ids = boxes.cls.int().cpu().tolist() if boxes.cls is not None else []
            xyxy_boxes = boxes.xyxy.cpu().numpy() if boxes.xyxy is not None else []
            track_ids = boxes.id.int().cpu().tolist() if boxes.id is not None else list(range(1, len(xyxy_boxes) + 1))

            for box, cls_id, t_id in zip(xyxy_boxes, cls_ids, track_ids):
                if cls_id not in TARGET_CLASSES:
                    continue

                class_name = TARGET_CLASSES[cls_id]
                x1, y1, x2, y2 = box
                cx = int((x1 + x2) / 2.0)
                cy = int((y1 + y2) / 2.0)
                current_pos = (cx, cy)
                current_track_ids.add(t_id)

                # Check Line Segment Intersection
                if t_id in track_positions:
                    last_pos = track_positions[t_id]
                    
                    if t_id not in counted_ids:
                        # Check segment intersection (A-B virtual line vs C-D trajectory)
                        if segments_intersect(p1, p2, last_pos, current_pos):
                            last_side = get_line_side(last_pos, p1, p2)
                            current_side = get_line_side(current_pos, p1, p2)
                            
                            direction = "in" if last_side <= 0 and current_side >= 0 else "out"
                            send_count_event(cam_id, class_name, direction)
                            counted_ids.add(t_id)
                
                # Update last position
                track_positions[t_id] = current_pos

                # Draw Visual Bounding Box & Centroid
                color = (0, 255, 0) if class_name == "person" else (0, 165, 255)
                cv2.rectangle(frame, (int(x1), int(y1)), (int(x2), int(y2)), color, 2)
                cv2.circle(frame, current_pos, 4, (0, 0, 255), -1)
                cv2.putText(frame, f"#{t_id} {class_name.upper()}", (int(x1), max(15, int(y1) - 6)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 2)

        # Cleanup old track positions
        for old_id in list(track_positions.keys()):
            if old_id not in current_track_ids:
                # Keep up to 30 frames before cleanup
                pass

        # Draw Virtual Crossing Line (Bold Red with Yellow Nodes)
        cv2.line(frame, p1, p2, (0, 0, 255), 3)
        cv2.circle(frame, p1, 7, (0, 255, 255), -1)
        cv2.circle(frame, p2, 7, (0, 255, 255), -1)
        cv2.putText(frame, "CROSSING LINE", (p1[0], max(25, p1[1] - 12)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 255), 2)

        # Save Snapshot Preview
        if frame_counter % 8 == 0:
            try:
                cv2.imwrite(snap_path, frame)
            except Exception:
                pass

    cap.release()
    print(f"[AI ENGINE] Stopped Object Counter for Camera #{cam_id}")

def main_loop():
    global running
    model_path = ensure_model()
    if not model_path:
        print("[AI ERR] Cannot start AI Engine without model file.")
        return

    print("[AI ENGINE] YOLO ByteTrack Object Counter Sidecar Service initialized.")
    
    while running:
        try:
            url = f"{BASE_URL}/api/ai/internal-config"
            res = requests.get(url, timeout=5)
            if res.status_code == 200:
                cameras = res.json().get("cameras", [])
                active_cam_ids = set()

                for cam in cameras:
                    if cam.get("ai_enabled") == 1:
                        cam_id = cam["id"]
                        active_cam_ids.add(cam_id)
                        
                        if cam_id not in active_threads or not active_threads[cam_id]["thread"].is_alive():
                            t_info = {"active": True}
                            t = threading.Thread(target=process_camera_stream, args=(cam, model_path), daemon=True)
                            t_info["thread"] = t
                            active_threads[cam_id] = t_info
                            t.start()

                for cam_id in list(active_threads.keys()):
                    if cam_id not in active_cam_ids:
                        active_threads[cam_id]["active"] = False
                        del active_threads[cam_id]

        except Exception as e:
            print(f"[AI ENGINE] Connection error to Node.js backend: {e}")
        
        time.sleep(8)

if __name__ == "__main__":
    try:
        main_loop()
    except KeyboardInterrupt:
        running = False
        print("[AI ENGINE] Shutting down...")

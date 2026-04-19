const camera = document.getElementById('camera');
const canvas = document.getElementById('snapshot');
const startCameraBtn = document.getElementById('startCameraBtn');
const captureBtn = document.getElementById('captureBtn');
const refreshBtn = document.getElementById('refreshBtn');
const eventLog = document.getElementById('eventLog');
const activeTableBody = document.getElementById('activeTableBody');
const manualPlateInput = document.getElementById('manualPlate');
const snapshotPreview = document.getElementById('snapshotPreview');

let mediaStream;

async function startCamera() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false
    });

    camera.srcObject = mediaStream;
    await new Promise((resolve) => {
      camera.onloadedmetadata = () => resolve();
    });

    captureBtn.disabled = false;
    startCameraBtn.disabled = true;
    eventLog.textContent = 'Camera ready. Capture a plate image.';
  } catch (error) {
    eventLog.textContent = `Camera error: ${error.message}`;
  }
}

function drawSnapshot() {
  if (!camera.videoWidth || !camera.videoHeight) {
    throw new Error('Camera stream is not ready yet. Wait a second and capture again.');
  }

  const ctx = canvas.getContext('2d');
  canvas.width = camera.videoWidth;
  canvas.height = camera.videoHeight;
  ctx.drawImage(camera, 0, 0, canvas.width, canvas.height);
  const capturedImage = canvas.toDataURL('image/jpeg', 0.9);
  snapshotPreview.src = capturedImage;
  snapshotPreview.hidden = false;
  return capturedImage;
}

function formatEventResponse(data) {
  const sourceLabel = data.source ? `<br/>Source: ${data.source}` : '';
  const rawTextLabel = data.rawOcrText ? `<br/>OCR Text: ${data.rawOcrText}` : '';

  if (data.event === 'Entry') {
    return `<strong>ENTRY</strong>: ${data.plate} at ${data.timestamp}${sourceLabel}${rawTextLabel}`;
  }

  return `<strong>EXIT</strong>: ${data.plate}<br/>Duration: ${data.durationLabel}<br/>Entry: ${data.entryTime}<br/>Exit: ${data.exitTime}${sourceLabel}${rawTextLabel}`;
}

async function processCapture() {
  try {
    const imageData = drawSnapshot();
    const plateText = (manualPlateInput.value || '').trim();

    const response = await fetch('/api/process-plate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageData, plateText })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to process plate.');
    }

    eventLog.innerHTML = formatEventResponse(data);
    manualPlateInput.value = '';
    await loadActiveCars();
  } catch (error) {
    eventLog.textContent = error.message;
  }
}

async function loadActiveCars() {
  const response = await fetch('/api/active');
  const { cars } = await response.json();

  if (!cars.length) {
    activeTableBody.innerHTML = '<tr><td colspan="2" class="empty-state">No active cars.</td></tr>';
    return;
  }

  activeTableBody.innerHTML = cars
    .map(
      (car) =>
        `<tr>
          <td>${car.plate}</td>
          <td>${car.entryTime}</td>
        </tr>`
    )
    .join('');
}

startCameraBtn.addEventListener('click', startCamera);
captureBtn.addEventListener('click', processCapture);
refreshBtn.addEventListener('click', loadActiveCars);

loadActiveCars();
setInterval(loadActiveCars, 5000);

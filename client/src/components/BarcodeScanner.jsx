import { useEffect, useRef, useState } from "react";
import {
  Html5Qrcode,
  Html5QrcodeSupportedFormats,
} from "html5-qrcode";

/** QR_CODE en tête : décodage prioritaire pour les QR carrés. */
const MEDICATION_FORMATS = [
  Html5QrcodeSupportedFormats.QR_CODE,
  Html5QrcodeSupportedFormats.DATA_MATRIX,
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.CODE_39,
  Html5QrcodeSupportedFormats.CODE_93,
  Html5QrcodeSupportedFormats.ITF,
  Html5QrcodeSupportedFormats.CODABAR,
];

async function pickCameraIdOrConstraints() {
  try {
    const devices = await Html5Qrcode.getCameras();
    if (!devices?.length) {
      return { facingMode: "environment" };
    }
    const label = (d) => (d.label || "").toLowerCase();
    const back = devices.find((d) =>
      /back|rear|environment|wide|ultra|arrière|dos|world/i.test(label(d))
    );
    if (back) return back.id;
    if (devices.length > 1) return devices[devices.length - 1].id;
    return devices[0].id;
  } catch {
    return { facingMode: "environment" };
  }
}

/** html5-qrcode crée la vidéo avec une largeur = clientWidth du conteneur ; si c’est 0, la vidéo est invisible. */
function forceVideoVisible(hostId) {
  const host = document.getElementById(hostId);
  if (!host) return;
  const apply = () => {
    const v = host.querySelector("video");
    if (!v) return;
    v.style.setProperty("width", "100%", "important");
    v.style.setProperty("max-width", "100%", "important");
    v.style.setProperty("height", "100%", "important");
    v.style.setProperty("min-height", "220px", "important");
    v.style.setProperty("object-fit", "cover", "important");
    v.style.setProperty("display", "block", "important");
    v.style.setProperty("background", "#000", "important");
    v.playsInline = true;
    v.setAttribute("playsinline", "true");
  };
  apply();
  requestAnimationFrame(apply);
  setTimeout(apply, 50);
  setTimeout(apply, 200);
}

export default function BarcodeScanner({ onDetected, onClose }) {
  const regionId = useRef(`qr-${Math.random().toString(36).slice(2)}`);
  const hostRef = useRef(null);
  const scannerRef = useRef(null);
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;
  const [err, setErr] = useState(null);
  const [starting, setStarting] = useState(true);
  const [cameraLive, setCameraLive] = useState(false);

  async function safeStopAndClear(scanner) {
    if (!scanner) return;
    try {
      if (scanner.isScanning) {
        await scanner.stop();
      }
    } catch {}
    try {
      await scanner.clear();
    } catch {}
  }

  useEffect(() => {
    let cancelled = false;
    const id = regionId.current;

    async function startWhenSized() {
      setErr(null);
      setStarting(true);
      setCameraLive(false);

      const host = hostRef.current;
      if (!host) return;

      let attempts = 0;
      while (attempts < 30 && host.offsetWidth < 40 && !cancelled) {
        await new Promise((r) => requestAnimationFrame(r));
        attempts += 1;
      }
      await new Promise((r) => setTimeout(r, 50));
      if (cancelled) return;

      try {
        const scanner = new Html5Qrcode(id, {
          verbose: false,
          formatsToSupport: MEDICATION_FORMATS,
          useBarCodeDetectorIfSupported: false,
        });
        scannerRef.current = scanner;

        let camera = await pickCameraIdOrConstraints();

        const startWithCamera = async (cam) =>
          scanner.start(
            cam,
            {
              fps: 20,
              /**
               * Zone plus large que haute: meilleure détection des codes-barres 1D.
               * Les QR restent lisibles car la zone reste centrée et suffisamment grande.
               */
              qrbox: (vw, vh) => {
                const minEdge = Math.min(vw, vh);
                const width = Math.max(220, Math.min(Math.floor(vw * 0.9), vw - 16));
                const height = Math.max(120, Math.min(Math.floor(minEdge * 0.42), vh - 16));
                return { width, height };
              },
              disableFlip: false,
            },
            (decodedText) => {
              if (cancelled) return;
              const s = scannerRef.current;
              try {
                if (s?.isScanning) s.pause(true);
              } catch {}
              onDetectedRef.current?.(decodedText);
            },
            () => {}
          );

        try {
          await startWithCamera(camera);
        } catch (firstErr) {
          if (
            cancelled ||
            typeof camera === "string" ||
            (camera &&
              typeof camera === "object" &&
              "facingMode" in camera === false)
          ) {
            throw firstErr;
          }
          const devices = await Html5Qrcode.getCameras();
          if (devices?.length) {
            camera = devices[0].id;
            await startWithCamera(camera);
          } else {
            throw firstErr;
          }
        }

        if (!cancelled) {
          forceVideoVisible(id);
          setCameraLive(true);
        }
      } catch (e) {
        if (!cancelled) {
          setErr(
            e?.message ||
              "Impossible d’accéder à la caméra. Vérifiez les permissions."
          );
        }
      } finally {
        if (!cancelled) setStarting(false);
      }
    }

    startWhenSized();

    return () => {
      cancelled = true;
      const s = scannerRef.current;
      scannerRef.current = null;
      safeStopAndClear(s);
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black p-3 sm:p-4">
      <div className="flex shrink-0 justify-between items-center text-white mb-2 gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">
            Scanner QR (carré) ou code-barres
          </p>
          {cameraLive && !err && (
            <p className="text-xs text-emerald-300 flex items-center gap-1.5 mt-0.5">
              <span
                className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse"
                aria-hidden
              />
              Placez le QR entier dans le cadre vert (forme carrée)
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-lg bg-white/15 px-3 py-1.5 text-sm hover:bg-white/25"
        >
          Fermer
        </button>
      </div>

      {/* Un seul nœud avec id + ref : html5-qrcode mesure clientWidth sur CET élément */}
      <div className="flex-1 flex flex-col items-center justify-center min-h-0 w-full px-1">
        <div
          className="relative w-full max-w-2xl rounded-xl border-2 border-clinic-500/60 bg-neutral-950 overflow-hidden shadow-2xl"
          style={{
            height: "min(62vh, 460px)",
            minHeight: 260,
            maxWidth: "42rem",
          }}
        >
          <div
            ref={hostRef}
            id={regionId.current}
            className="box-border h-full w-full min-h-[260px] bg-black"
            style={{ width: "100%", minHeight: 260 }}
          />
          {starting && !err && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-neutral-900/95 text-white text-sm z-10 pointer-events-none">
              <span className="inline-block h-10 w-10 border-2 border-clinic-400 border-t-transparent rounded-full animate-spin mb-3" />
              Ouverture de la caméra…
            </div>
          )}
        </div>
        <p className="text-xs text-white/65 text-center mt-3 max-w-lg px-2">
          <strong className="text-white/85">QR code :</strong> alignez le carré
          du QR dans le cadre vert (même forme). Pour un code-barres, centrez la
          bande dans ce cadre. Évitez le flou et le contre-jour.
        </p>
      </div>

      {err && (
        <p className="shrink-0 text-center text-amber-200 text-sm mt-2 max-w-md mx-auto px-2">
          {err}
        </p>
      )}
    </div>
  );
}

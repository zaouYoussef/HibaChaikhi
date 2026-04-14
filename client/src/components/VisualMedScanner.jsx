import { useEffect, useRef, useState } from "react";

export default function VisualMedScanner({ onFrameAnalyze, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const busyRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Initialisation caméra...");
  const [err, setErr] = useState("");

  function stopAll() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      streamRef.current = null;
    }
  }

  async function analyzeCurrentFrame() {
    if (busyRef.current || !videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    if (!video.videoWidth || !video.videoHeight) return;

    busyRef.current = true;
    setStatus("Lecture automatique en cours...");
    try {
      const canvas = canvasRef.current;
      const maxWidth = 1280;
      const ratio = Math.min(1, maxWidth / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * ratio);
      canvas.height = Math.round(video.videoHeight * ratio);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageBase64 = canvas.toDataURL("image/jpeg", 0.78);
      const ok = await onFrameAnalyze?.(imageBase64);
      if (ok) {
        stopAll();
        return;
      }
      setStatus("Analyse faite. Continuez à cadrer le médicament...");
    } catch (e) {
      setErr(e?.message || "Analyse image impossible.");
      setStatus("Échec de lecture. Ajustez lumière/netteté.");
    } finally {
      busyRef.current = false;
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        if (cancelled) {
          for (const t of stream.getTracks()) t.stop();
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setReady(true);
        setStatus("Pointez le médicament, lecture automatique active.");
        timerRef.current = setInterval(() => {
          analyzeCurrentFrame();
        }, 2200);
      } catch (e) {
        setErr(
          e?.message || "Impossible d'accéder à la caméra. Vérifiez les permissions."
        );
      }
    })();
    return () => {
      cancelled = true;
      stopAll();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black p-3 sm:p-4">
      <div className="mb-2 flex items-center justify-between gap-2 text-white">
        <div>
          <p className="text-sm font-semibold">Lecture caméra automatique (IA)</p>
          <p className="text-xs text-white/75">
            Cadrez le nom + dosage de la boîte. Détection toutes les 2 secondes.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            stopAll();
            onClose?.();
          }}
          className="rounded-lg bg-white/15 px-3 py-1.5 text-sm hover:bg-white/25"
        >
          Fermer
        </button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="relative h-[62vh] min-h-[280px] w-full max-w-2xl overflow-hidden rounded-xl border-2 border-clinic-500/60 bg-black">
          <video
            ref={videoRef}
            className="h-full w-full object-cover"
            autoPlay
            playsInline
            muted
          />
          {!ready && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/75 text-sm text-white">
              Ouverture caméra...
            </div>
          )}
          <div className="pointer-events-none absolute inset-8 rounded-2xl border-2 border-emerald-400/80" />
        </div>
      </div>

      <canvas ref={canvasRef} className="hidden" />

      <div className="mt-3 flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={analyzeCurrentFrame}
          className="rounded-lg bg-clinic-600 px-4 py-2 text-sm font-semibold text-white hover:bg-clinic-700"
        >
          Scanner maintenant
        </button>
      </div>

      {status && (
        <p className="mt-2 text-center text-xs text-emerald-200">{status}</p>
      )}
      {err && <p className="mt-2 text-center text-xs text-amber-300">{err}</p>}
    </div>
  );
}

import { useEffect } from "react";

type Particle = {
  x: number;
  y: number;
  r: number;
  vy: number;
  vx: number;
  a: number;
  crimson: boolean;
};

type UseParticleFieldOptions = {
  enabled?: boolean;
  count?: number;
};

/**
 * Drive a canvas particle field — the soft snowfall of pale dots
 * (with the occasional crimson sparkle) that drifts upward across
 * the dark MarketSection background.
 *
 * Verbatim port of the v3 design's params: 60 particles, ~1 in 12
 * are crimson with a soft shadow-glow, drift 0.10–0.32 px/frame
 * upward, very slight horizontal jitter, respawn at the bottom
 * when they exit the top.
 *
 * DPR-aware (capped at 2× for mobile GPUs). Listens for resize and
 * re-initialises after a 120ms debounce. Honors prefers-reduced-
 * motion: paints a single static frame and exits without starting
 * the rAF loop.
 *
 * Pass a canvas ref and (optionally) `enabled=false` to suspend
 * the loop without unmounting the canvas.
 */
export function useParticleField(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  options: UseParticleFieldOptions = {},
) {
  const { enabled = true, count = 60 } = options;

  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0;
    let H = 0;
    let parts: Particle[] = [];
    let rafId = 0;
    let resizeTimer = 0;

    function resize() {
      if (!canvas || !ctx) return;
      const r = canvas.getBoundingClientRect();
      W = r.width;
      H = r.height;
      canvas.width = W * DPR;
      canvas.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }

    function spawn(initial: boolean): Particle {
      return {
        x: Math.random() * W,
        y: initial ? Math.random() * H : H + Math.random() * 40,
        r: 0.6 + Math.random() * 1.6,
        vy: 0.1 + Math.random() * 0.22,
        vx: (Math.random() - 0.5) * 0.05,
        a: 0.25 + Math.random() * 0.55,
        crimson: false,
      };
    }

    function init() {
      resize();
      parts = [];
      for (let i = 0; i < count; i++) {
        const p = spawn(true);
        if (i % 12 === 5) p.crimson = true;
        parts.push(p);
      }
    }

    function paint() {
      if (!ctx) return;
      ctx.clearRect(0, 0, W, H);
      for (const p of parts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        if (p.crimson) {
          ctx.fillStyle = `rgba(215,38,61,${Math.min(1, p.a + 0.15)})`;
          ctx.shadowColor = "rgba(215,38,61,.55)";
          ctx.shadowBlur = 8;
        } else {
          ctx.fillStyle = `rgba(241,236,226,${p.a * 0.7})`;
          ctx.shadowBlur = 0;
        }
        ctx.fill();
      }
    }

    function tick() {
      for (const p of parts) {
        p.y -= p.vy;
        p.x += p.vx;
        if (p.y < -10) {
          Object.assign(p, spawn(false));
          p.crimson = Math.random() < 1 / 12;
        }
      }
      paint();
      rafId = window.requestAnimationFrame(tick);
    }

    function onResize() {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(init, 120);
    }

    init();
    if (reduced) {
      paint();
      return;
    }
    rafId = window.requestAnimationFrame(tick);
    window.addEventListener("resize", onResize);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
    };
  }, [canvasRef, enabled, count]);
}

export default useParticleField;

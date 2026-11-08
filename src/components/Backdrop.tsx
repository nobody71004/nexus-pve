import { useEffect, useRef } from "react";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  hue: number;
}

export function Backdrop({ reduced }: { reduced: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointer = useRef({ x: -999, y: -999, active: false });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let raf = 0;
    let time = 0;
    let particles: Particle[] = [];
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const build = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(90, Math.max(36, Math.floor((width * height) / 26_000)));
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.16,
        vy: (Math.random() - 0.5) * 0.16,
        size: Math.random() * 1.5 + 0.4,
        hue: 174 + Math.random() * 70,
      }));
    };

    const drawBlob = (x: number, y: number, radius: number, color: string, alpha: number) => {
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, color.replace("ALPHA", String(alpha)));
      gradient.addColorStop(1, color.replace("ALPHA", "0"));
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    };

    const render = () => {
      time += reduced ? 0 : 0.0035;
      ctx.clearRect(0, 0, width, height);

      // Aurora field: three slow plasma masses.
      ctx.globalCompositeOperation = "lighter";
      drawBlob(
        width * (0.22 + Math.sin(time * 1.1) * 0.05),
        height * (0.3 + Math.cos(time * 0.8) * 0.06),
        Math.max(width, height) * 0.44,
        "rgba(26, 190, 220, ALPHA)",
        0.16,
      );
      drawBlob(
        width * (0.76 + Math.cos(time * 0.9) * 0.06),
        height * (0.2 + Math.sin(time * 0.7) * 0.05),
        Math.max(width, height) * 0.4,
        "rgba(97, 72, 255, ALPHA)",
        0.15,
      );
      drawBlob(
        width * (0.55 + Math.sin(time * 0.6 + 1.7) * 0.08),
        height * (0.92 + Math.cos(time * 0.5) * 0.04),
        Math.max(width, height) * 0.38,
        "rgba(16, 220, 160, ALPHA)",
        0.1,
      );
      ctx.globalCompositeOperation = "source-over";

      // Reactive particle mesh.
      const px = pointer.current.x;
      const py = pointer.current.y;
      for (const particle of particles) {
        if (!reduced) {
          particle.x += particle.vx;
          particle.y += particle.vy;
          if (particle.x < -20) particle.x = width + 20;
          if (particle.x > width + 20) particle.x = -20;
          if (particle.y < -20) particle.y = height + 20;
          if (particle.y > height + 20) particle.y = -20;
          if (pointer.current.active) {
            const dx = px - particle.x;
            const dy = py - particle.y;
            const distance = Math.hypot(dx, dy);
            if (distance < 220 && distance > 1) {
              const force = (1 - distance / 220) * 0.035;
              particle.x += (dx / distance) * force * 12;
              particle.y += (dy / distance) * force * 12;
            }
          }
        }
        ctx.fillStyle = `hsla(${particle.hue}, 95%, 68%, 0.55)`;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
        ctx.fill();
      }

      // Links between nearby nodes, brighter near the cursor.
      for (let i = 0; i < particles.length; i += 1) {
        for (let j = i + 1; j < particles.length; j += 1) {
          const a = particles[i];
          const b = particles[j];
          const distance = Math.hypot(a.x - b.x, a.y - b.y);
          if (distance > 132) continue;
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const near = pointer.current.active ? Math.max(0, 1 - Math.hypot(mid.x - px, mid.y - py) / 300) : 0;
          ctx.strokeStyle = `hsla(${(a.hue + b.hue) / 2}, 90%, 65%, ${0.06 + near * 0.16})`;
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      if (pointer.current.active && !reduced) {
        const halo = ctx.createRadialGradient(px, py, 0, px, py, 180);
        halo.addColorStop(0, "rgba(74, 240, 255, 0.09)");
        halo.addColorStop(1, "rgba(74, 240, 255, 0)");
        ctx.fillStyle = halo;
        ctx.fillRect(px - 180, py - 180, 360, 360);
      }

      if (!reduced) raf = requestAnimationFrame(render);
    };

    const onPointer = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY, active: true };
    };
    const onLeave = () => {
      pointer.current.active = false;
    };

    build();
    render();

    window.addEventListener("resize", build);
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("pointerleave", onLeave);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", build);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerleave", onLeave);
    };
  }, [reduced]);

  return (
    <div className="backdrop" aria-hidden="true">
      <canvas ref={canvasRef} />
      <div className="backdrop-grid" />
      <div className="backdrop-scan" />
      <div className="backdrop-vignette" />
    </div>
  );
}

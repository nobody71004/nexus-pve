import { useEffect, useRef } from "react";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  hue: number;
}

interface Wave {
  x: number;
  y: number;
  radius: number;
  life: number;
  hue: number;
}

const INTERACTIVE =
  "button, a, input, select, textarea, label, [role='tab'], [role='button'], .rail-item, .team-tab, .member-pick, .rail-host, .team-link-chip";
const SPOTLIGHT =
  ".panel, .team-summary, .sshkeys-panel, .sshkeys-key, .sshkeys-host, .sshkeys-issued, article, .rail, .titlebar, .auth-card";

/**
 * A cursor-reactive overlay: damped dual ring, velocity-stretched trail,
 * orbiting hover satellites, click shockwaves and a spotlight that follows the
 * pointer across cards and tabs. Purely decorative and pointer-transparent.
 */
export function PointerFX({ enabled }: { enabled: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const root = document.documentElement;
    root.classList.add("fx-on");

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let width = window.innerWidth;
    let height = window.innerHeight;
    let raf = 0;
    let time = 0;
    let lastHit: Element | null = null;
    let lastSpot: HTMLElement | null = null;
    const particles: Particle[] = [];
    const waves: Wave[] = [];
    const pointer = {
      x: width / 2,
      y: height / 2,
      tx: width / 2,
      ty: height / 2,
      px: width / 2,
      py: height / 2,
      inside: false,
      down: false,
      hover: false,
    };

    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const burst = (x: number, y: number, count: number, power: number, hue = 188) => {
      for (let index = 0; index < count; index += 1) {
        const angle = Math.random() * Math.PI * 2;
        const speed = power * (0.35 + Math.random() * 0.9);
        particles.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1,
          max: 24 + Math.random() * 28,
          size: 0.8 + Math.random() * 1.9,
          hue: hue + (Math.random() - 0.5) * 70,
        });
      }
      if (particles.length > 220) particles.splice(0, particles.length - 220);
    };

    const wave = (x: number, y: number, hue = 188) => {
      waves.push({ x, y, radius: 4, life: 1, hue });
      if (waves.length > 12) waves.shift();
    };

    const onMove = (event: PointerEvent) => {
      pointer.tx = event.clientX;
      pointer.ty = event.clientY;
      pointer.inside = true;
      const target = event.target instanceof Element ? event.target : null;
      const hit = target?.closest?.(INTERACTIVE) ?? null;
      pointer.hover = Boolean(hit);
      if (hit && hit !== lastHit) {
        burst(pointer.tx, pointer.ty, 5, 0.9, 205);
        lastHit = hit;
      } else if (!hit) {
        lastHit = null;
      }

      const spot = (target?.closest?.(SPOTLIGHT) ?? null) as HTMLElement | null;
      if (spot !== lastSpot) {
        lastSpot?.style.removeProperty("--fx-x");
        lastSpot?.style.removeProperty("--fx-y");
        lastSpot = spot;
      }
      if (spot) {
        const rect = spot.getBoundingClientRect();
        spot.style.setProperty("--fx-x", `${event.clientX - rect.left}px`);
        spot.style.setProperty("--fx-y", `${event.clientY - rect.top}px`);
      }
    };
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      pointer.down = true;
      const target = event.target instanceof Element ? event.target : null;
      const tab = target?.closest?.(".rail-item, .team-tab, .team-tab, .btn.primary, .sshkeys-btn");
      burst(pointer.tx, pointer.ty, tab ? 26 : 16, tab ? 1.7 : 1.2, tab ? 176 : 194);
      wave(pointer.tx, pointer.ty, tab ? 176 : 196);
    };
    const onUp = () => {
      if (!pointer.down) return;
      pointer.down = false;
      wave(pointer.tx, pointer.ty, 270);
    };
    const onLeave = () => {
      pointer.inside = false;
      lastHit = null;
      pointer.hover = false;
      particles.length = 0;
      waves.length = 0;
      ctx.clearRect(0, 0, width, height);
      if (lastSpot) {
        lastSpot.style.removeProperty("--fx-x");
        lastSpot.style.removeProperty("--fx-y");
        lastSpot = null;
      }
    };
    const onBlur = () => onLeave();

    let emittedX = pointer.x;
    let emittedY = pointer.y;

    const render = () => {
      time += 0.016;
      pointer.px = pointer.x;
      pointer.py = pointer.y;
      const ease = pointer.down ? 0.34 : 0.18;
      pointer.x += (pointer.tx - pointer.x) * ease;
      pointer.y += (pointer.ty - pointer.y) * ease;
      const vx = pointer.x - pointer.px;
      const vy = pointer.y - pointer.py;
      const speed = Math.hypot(vx, vy);

      // A tapered, velocity-aware trail.
      if (pointer.inside && speed > 0.35 && Math.hypot(pointer.x - emittedX, pointer.y - emittedY) > 1.4) {
        emittedX = pointer.x;
        emittedY = pointer.y;
        particles.push({
          x: pointer.x + (Math.random() - 0.5) * 5,
          y: pointer.y + (Math.random() - 0.5) * 5,
          vx: vx * 0.24 + (Math.random() - 0.5) * 0.55,
          vy: vy * 0.24 + (Math.random() - 0.5) * 0.55,
          life: 1,
          max: 18 + Math.random() * 18,
          size: 0.5 + Math.random() * 1.5,
          hue: 178 + Math.random() * 58,
        });
      }

      ctx.clearRect(0, 0, width, height);
      if (!pointer.inside) {
        raf = requestAnimationFrame(render);
        return;
      }

      ctx.globalCompositeOperation = "lighter";

      // Trailing dust.
      for (let index = particles.length - 1; index >= 0; index -= 1) {
        const particle = particles[index];
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.vx *= 0.955;
        particle.vy *= 0.955;
        particle.life -= 1 / particle.max;
        if (particle.life <= 0) {
          particles.splice(index, 1);
          continue;
        }
        const alpha = Math.max(0, particle.life) * 0.62;
        ctx.fillStyle = `hsla(${particle.hue}, 100%, 72%, ${alpha})`;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size * (0.4 + particle.life * 0.6), 0, Math.PI * 2);
        ctx.fill();
      }

      // Click shockwaves.
      for (let index = waves.length - 1; index >= 0; index -= 1) {
        const waveItem = waves[index];
        waveItem.radius += 4.6;
        waveItem.life -= 0.035;
        if (waveItem.life <= 0) {
          waves.splice(index, 1);
          continue;
        }
        ctx.strokeStyle = `hsla(${waveItem.hue}, 100%, 70%, ${waveItem.life * 0.42})`;
        ctx.lineWidth = 1 + waveItem.life * 1.4;
        ctx.beginPath();
        ctx.arc(waveItem.x, waveItem.y, waveItem.radius, 0, Math.PI * 2);
        ctx.stroke();
      }

      const hovered = pointer.hover;
      const baseRadius = pointer.down ? 9 : hovered ? 20 : 13;
      const pulse = Math.sin(time * 4.4) * (hovered ? 1.6 : 0.9);

      // Wide atmospheric halo.
      const halo = ctx.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, hovered ? 82 : 58);
      halo.addColorStop(0, `rgba(62, 242, 255, ${pointer.down ? 0.2 : 0.13})`);
      halo.addColorStop(0.5, "rgba(116, 96, 255, 0.055)");
      halo.addColorStop(1, "rgba(62, 242, 255, 0)");
      ctx.fillStyle = halo;
      ctx.fillRect(pointer.x - 90, pointer.y - 90, 180, 180);

      // Outer dashed ring, rotating opposite the hover orbit.
      ctx.save();
      ctx.translate(pointer.x, pointer.y);
      ctx.strokeStyle = `rgba(62, 242, 255, ${hovered ? 0.75 : 0.46})`;
      ctx.lineWidth = hovered ? 1.35 : 0.9;
      ctx.setLineDash(hovered ? [5, 6] : [3, 8]);
      ctx.lineDashOffset = -time * (hovered ? 34 : 18);
      ctx.beginPath();
      ctx.arc(0, 0, baseRadius + pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Secondary violet orbit.
      ctx.strokeStyle = `rgba(151, 117, 255, ${hovered ? 0.6 : 0.32})`;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(0, 0, baseRadius * 0.62, 0, Math.PI * 2);
      ctx.stroke();

      // Reaction tick pointing along the direction of travel.
      if (speed > 0.4) {
        const angle = Math.atan2(vy, vx);
        const inner = baseRadius + 5 + pulse;
        ctx.strokeStyle = "rgba(190, 250, 255, 0.8)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
        ctx.lineTo(Math.cos(angle) * (inner + 6), Math.sin(angle) * (inner + 6));
        ctx.stroke();
      }

      // Hover satellites.
      if (hovered) {
        for (let index = 0; index < 3; index += 1) {
          const angle = time * 1.9 + (index * Math.PI * 2) / 3;
          const orbit = baseRadius + 9 + Math.sin(time * 3 + index) * 2;
          const x = Math.cos(angle) * orbit;
          const y = Math.sin(angle) * orbit;
          ctx.fillStyle = index === 0 ? "rgba(61, 255, 168, 0.9)" : index === 1 ? "rgba(62, 242, 255, 0.85)" : "rgba(160, 120, 255, 0.85)";
          ctx.beginPath();
          ctx.arc(x, y, 1.55, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Damped core.
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, pointer.down ? 5.5 : 3.6);
      core.addColorStop(0, "rgba(255, 255, 255, 0.95)");
      core.addColorStop(0.5, "rgba(170, 250, 255, 0.8)");
      core.addColorStop(1, "rgba(62, 242, 255, 0)");
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(0, 0, pointer.down ? 5.5 : 3.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(render);
    };

    render();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    document.addEventListener("pointerleave", onLeave);
    window.addEventListener("blur", onBlur);

    return () => {
      cancelAnimationFrame(raf);
      root.classList.remove("fx-on");
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      document.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("blur", onBlur);
      lastSpot?.style.removeProperty("--fx-x");
      lastSpot?.style.removeProperty("--fx-y");
    };
  }, [enabled]);

  if (!enabled) return null;
  return <canvas ref={canvasRef} className="pointer-fx" aria-hidden="true" />;
}

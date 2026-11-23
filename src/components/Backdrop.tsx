import { useEffect, useRef } from "react";

const TAU = Math.PI * 2;

// The backdrop owns two full-screen canvases: the live twinkle layer and a
// detached static layer. Cap both DPR and backing pixels so high-DPI or scaled
// large displays cannot allocate tens of megabytes per layer. All scene
// coordinates remain CSS pixels; only the backing stores are scaled down.
const MAX_BACKING_DPR = 1.5;
const MAX_BACKING_PIXELS = 3_000_000;

interface Star {
  x: number;
  y: number;
  radius: number;
  alpha: number;
  phase: number;
  speed: number;
  hue: number;
  depth: number;
}

interface Cluster {
  x: number;
  y: number;
  radius: number;
  hue: number;
  stars: Star[];
}

interface Galaxy {
  x: number;
  y: number;
  radius: number;
  rotation: number;
  flatten: number;
  hue: number;
  arms: number;
  elliptical?: boolean;
}

interface Meteor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  length: number;
}

function mulberry32(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random: () => number) {
  return (random() + random() + random() - 1.5) / 1.5;
}

function rgba(r: number, g: number, b: number, alpha: number) {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const STAR_COLORS: Array<[number, number, number]> = [
  [196, 224, 255],
  [172, 198, 255],
  [255, 229, 196],
  [186, 255, 240],
  [220, 196, 255],
  [255, 250, 245],
];

const NEBULA_COLORS: Array<[number, number, number]> = [
  [44, 125, 200],
  [103, 83, 220],
  [171, 78, 194],
  [44, 190, 170],
  [43, 88, 175],
];

export function Backdrop({ reduced }: { reduced: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const staticLayer = document.createElement("canvas");
    const staticCtx = staticLayer.getContext("2d", { alpha: false });
    if (!staticCtx) return;

    let width = 0;
    let height = 0;
    let liveStars: Star[] = [];
    let clusters: Cluster[] = [];
    let meteors: Meteor[] = [];
    let nextMeteor = 4 + Math.random() * 7;
    let raf = 0;
    let time = 0;
    let lastFrame = 0;
    let destroyed = false;
    const pointer = {
      x: 0,
      y: 0,
      tx: 0,
      ty: 0,
      active: false,
      smoothX: 0,
      smoothY: 0,
    };

    const starColor = (hue: number, alpha: number) => {
      const color = STAR_COLORS[hue % STAR_COLORS.length];
      return rgba(color[0], color[1], color[2], alpha);
    };

    const paintNebula = (
      target: CanvasRenderingContext2D,
      x: number,
      y: number,
      radiusX: number,
      radiusY: number,
      rotation: number,
      color: [number, number, number],
      alpha: number,
    ) => {
      target.save();
      target.translate(x, y);
      target.rotate(rotation);
      target.scale(1, radiusY / radiusX);
      const gradient = target.createRadialGradient(0, 0, 0, 0, 0, radiusX);
      gradient.addColorStop(0, rgba(color[0], color[1], color[2], alpha));
      gradient.addColorStop(0.35, rgba(color[0], color[1], color[2], alpha * 0.55));
      gradient.addColorStop(0.7, rgba(color[0], color[1], color[2], alpha * 0.18));
      gradient.addColorStop(1, rgba(color[0], color[1], color[2], 0));
      target.fillStyle = gradient;
      target.beginPath();
      target.arc(0, 0, radiusX, 0, TAU);
      target.fill();
      target.restore();
    };

    const paintBrightStar = (
      target: CanvasRenderingContext2D,
      star: Star,
      intensity = 1,
      parallaxX = 0,
      parallaxY = 0,
    ) => {
      const x = star.x + parallaxX;
      const y = star.y + parallaxY;
      const glowRadius = star.radius * 8 + 4;
      const glow = target.createRadialGradient(x, y, 0, x, y, glowRadius);
      glow.addColorStop(0, starColor(star.hue, 0.32 * intensity));
      glow.addColorStop(0.45, starColor(star.hue, 0.08 * intensity));
      glow.addColorStop(1, starColor(star.hue, 0));
      target.fillStyle = glow;
      target.beginPath();
      target.arc(x, y, glowRadius, 0, TAU);
      target.fill();

      target.strokeStyle = starColor(star.hue, 0.28 * intensity);
      target.lineWidth = Math.max(0.5, star.radius * 0.38);
      target.beginPath();
      target.moveTo(x - star.radius * 7, y);
      target.lineTo(x + star.radius * 7, y);
      target.moveTo(x, y - star.radius * 6);
      target.lineTo(x, y + star.radius * 6);
      target.stroke();

      target.fillStyle = starColor(star.hue, 0.95 * intensity);
      target.beginPath();
      target.arc(x, y, star.radius * 0.9, 0, TAU);
      target.fill();
    };

    const paintGalaxy = (target: CanvasRenderingContext2D, galaxy: Galaxy, random: () => number) => {
      target.save();
      target.translate(galaxy.x, galaxy.y);
      target.rotate(galaxy.rotation);
      target.scale(1, galaxy.flatten);

      const halo = target.createRadialGradient(0, 0, 0, 0, 0, galaxy.radius * 1.25);
      halo.addColorStop(0, `hsla(${galaxy.hue}, 82%, 76%, 0.24)`);
      halo.addColorStop(0.22, `hsla(${galaxy.hue}, 78%, 68%, 0.11)`);
      halo.addColorStop(0.58, `hsla(${galaxy.hue}, 75%, 60%, 0.025)`);
      halo.addColorStop(1, `hsla(${galaxy.hue}, 75%, 55%, 0)`);
      target.fillStyle = halo;
      target.beginPath();
      target.arc(0, 0, galaxy.radius * 1.25, 0, TAU);
      target.fill();

      if (galaxy.elliptical) {
        for (let index = 0; index < 90; index += 1) {
          const angle = random() * TAU;
          const spread = 0.35 + random() * 0.65;
          const x = Math.cos(angle) * galaxy.radius * spread;
          const y = Math.sin(angle) * galaxy.radius * spread;
          const alpha = (1 - spread) * 0.18 + 0.03;
          target.fillStyle = `hsla(${galaxy.hue + (random() - 0.5) * 22}, 70%, 82%, ${alpha})`;
          target.beginPath();
          target.arc(x, y, 0.4 + random() * 0.9, 0, TAU);
          target.fill();
        }
      } else {
        for (let arm = 0; arm < galaxy.arms; arm += 1) {
          const armOffset = (arm / galaxy.arms) * TAU;
          for (let index = 0; index < 150; index += 1) {
            const progress = index / 150;
            const angle = armOffset + progress * 4.3;
            const distance = galaxy.radius * (0.12 + progress * 0.86);
            const spread = (random() - 0.5) * galaxy.radius * 0.12 * (1 - progress * 0.55);
            const x = Math.cos(angle) * distance + spread;
            const y = Math.sin(angle) * distance + spread;
            const alpha = (1 - progress) * 0.26 + 0.035;
            target.fillStyle = `hsla(${galaxy.hue + (random() - 0.5) * 28}, 78%, ${64 + random() * 20}%, ${alpha})`;
            target.beginPath();
            target.arc(x, y, 0.35 + random() * 1.05, 0, TAU);
            target.fill();
          }
        }

        target.strokeStyle = `hsla(${galaxy.hue}, 74%, 74%, 0.07)`;
        target.lineWidth = 1;
        for (let arm = 0; arm < galaxy.arms; arm += 1) {
          target.beginPath();
          for (let index = 0; index < 60; index += 1) {
            const progress = index / 60;
            const angle = (arm / galaxy.arms) * TAU + progress * 4.3;
            const distance = galaxy.radius * (0.1 + progress * 0.88);
            const x = Math.cos(angle) * distance;
            const y = Math.sin(angle) * distance;
            if (index === 0) target.moveTo(x, y);
            else target.lineTo(x, y);
          }
          target.stroke();
        }
      }

      const core = target.createRadialGradient(0, 0, 0, 0, 0, galaxy.radius * 0.34);
      core.addColorStop(0, `hsla(${galaxy.hue}, 95%, 94%, 0.7)`);
      core.addColorStop(0.2, `hsla(${galaxy.hue}, 90%, 80%, 0.34)`);
      core.addColorStop(0.6, `hsla(${galaxy.hue}, 82%, 65%, 0.1)`);
      core.addColorStop(1, `hsla(${galaxy.hue}, 82%, 60%, 0)`);
      target.fillStyle = core;
      target.beginPath();
      target.arc(0, 0, galaxy.radius * 0.34, 0, TAU);
      target.fill();
      target.restore();
    };

    const build = () => {
      width = Math.max(1, window.innerWidth);
      height = Math.max(1, window.innerHeight);
      const dpr = Math.min(MAX_BACKING_DPR, window.devicePixelRatio || 1);
      const budgetScale = Math.sqrt(MAX_BACKING_PIXELS / (width * height));
      const renderScale = Math.max(0.01, Math.min(dpr, budgetScale));
      const pixelWidth = Math.max(1, Math.round(width * renderScale));
      let pixelHeight = Math.max(1, Math.round(height * renderScale));
      // Rounding a wide canvas up must not nudge it over the pixel budget.
      if (pixelWidth * pixelHeight > MAX_BACKING_PIXELS) {
        pixelHeight = Math.max(1, Math.floor(MAX_BACKING_PIXELS / pixelWidth));
      }

      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);

      staticLayer.width = pixelWidth;
      staticLayer.height = pixelHeight;
      staticCtx.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);

      const random = mulberry32(0x5f3759df ^ (width * 31 + height * 17));
      const smallest = Math.min(width, height);
      const area = width * height;

      pointer.x = pointer.x || width * 0.62;
      pointer.y = pointer.y || height * 0.42;
      pointer.tx = pointer.tx || pointer.x;
      pointer.ty = pointer.ty || pointer.y;

      const background = staticCtx.createLinearGradient(0, 0, width * 0.35, height);
      background.addColorStop(0, "#02040c");
      background.addColorStop(0.38, "#040817");
      background.addColorStop(0.72, "#050a18");
      background.addColorStop(1, "#02040a");
      staticCtx.fillStyle = background;
      staticCtx.fillRect(0, 0, width, height);

      // Faint far-field nebulae.
      staticCtx.globalCompositeOperation = "lighter";
      paintNebula(staticCtx, width * 0.12, height * 0.16, smallest * 0.72, smallest * 0.4, -0.45, NEBULA_COLORS[1], 0.1);
      paintNebula(staticCtx, width * 0.91, height * 0.28, smallest * 0.62, smallest * 0.3, 0.6, NEBULA_COLORS[0], 0.08);
      paintNebula(staticCtx, width * 0.84, height * 0.88, smallest * 0.7, smallest * 0.36, -0.2, NEBULA_COLORS[2], 0.072);
      paintNebula(staticCtx, width * 0.28, height * 0.92, smallest * 0.54, smallest * 0.3, 0.15, NEBULA_COLORS[3], 0.058);

      // The Milky Way: a tilted luminous band with a warm core and dust lanes.
      const bandAngle = -0.46;
      const bandX = width * 0.53;
      const bandY = height * 0.48;
      const bandLength = Math.hypot(width, height) * 1.04;
      const bandWidth = smallest * 0.29;

      staticCtx.save();
      staticCtx.translate(bandX, bandY);
      staticCtx.rotate(bandAngle);
      for (let index = 0; index < 11; index += 1) {
        const progress = index / 10 - 0.5;
        const x = progress * bandLength;
        const y = gaussian(random) * bandWidth * 0.22;
        const radius = bandLength * (0.13 + random() * 0.08);
        const color = index % 2 === 0 ? NEBULA_COLORS[3] : NEBULA_COLORS[0];
        paintNebula(staticCtx, x, y, radius, bandWidth * (0.55 + random() * 0.22), 0, color, 0.05 + random() * 0.03);
      }
      paintNebula(staticCtx, 0, 0, bandLength * 0.3, bandWidth * 0.62, 0, [255, 214, 174], 0.115);
      paintNebula(staticCtx, 0, 0, bandLength * 0.2, bandWidth * 0.44, 0, [255, 240, 218], 0.105);

      // Dense stellar river inside the band.
      for (let index = 0; index < Math.min(2600, Math.floor(area / 850)); index += 1) {
        const along = (random() - 0.5) * bandLength;
        const perpendicular = gaussian(random) * bandWidth * 0.58;
        const x = bandX + Math.cos(bandAngle) * along - Math.sin(bandAngle) * perpendicular;
        const y = bandY + Math.sin(bandAngle) * along + Math.cos(bandAngle) * perpendicular;
        if (x < -4 || x > width + 4 || y < -4 || y > height + 4) continue;
        const radius = 0.22 + Math.pow(random(), 3) * 1.05;
        const alpha = 0.16 + random() * 0.62;
        staticCtx.fillStyle = starColor(Math.floor(random() * 6), alpha);
        staticCtx.beginPath();
        staticCtx.arc(x, y, radius, 0, TAU);
        staticCtx.fill();
      }

      // Dust lanes cut dark ribbons through the bright band.
      staticCtx.globalCompositeOperation = "source-over";
      for (let index = 0; index < 22; index += 1) {
        const progress = index / 21 - 0.5;
        const x = progress * bandLength;
        const y = gaussian(random) * bandWidth * 0.24;
        paintNebula(staticCtx, x, y, bandLength * (0.08 + random() * 0.08), bandWidth * (0.06 + random() * 0.08), 0, [1, 2, 7], 0.12 + random() * 0.16);
      }
      staticCtx.restore();

      // Background field stars.
      const fieldCount = Math.min(1500, Math.max(560, Math.floor(area / 1350)));
      for (let index = 0; index < fieldCount; index += 1) {
        const x = random() * width;
        const y = random() * height;
        const radius = 0.2 + Math.pow(random(), 3.2) * 1.65;
        const alpha = 0.14 + random() * 0.66;
        staticCtx.fillStyle = starColor(Math.floor(random() * 6), alpha);
        staticCtx.beginPath();
        staticCtx.arc(x, y, radius, 0, TAU);
        staticCtx.fill();
      }

      // Distant galaxies, placed in the darker corners of the field.
      const galaxies: Galaxy[] = [
        {
          x: width * 0.84,
          y: height * 0.2,
          radius: smallest * 0.105,
          rotation: -0.5,
          flatten: 0.44,
          hue: 214,
          arms: 2,
        },
        {
          x: width * 0.13,
          y: height * 0.72,
          radius: smallest * 0.072,
          rotation: 0.9,
          flatten: 0.55,
          hue: 276,
          arms: 2,
        },
        {
          x: width * 0.9,
          y: height * 0.76,
          radius: smallest * 0.052,
          rotation: -0.2,
          flatten: 0.38,
          hue: 188,
          arms: 3,
        },
        {
          x: width * 0.52,
          y: height * 0.105,
          radius: smallest * 0.046,
          rotation: 0.35,
          flatten: 0.48,
          hue: 202,
          arms: 2,
        },
        {
          x: width * 0.34,
          y: height * 0.13,
          radius: smallest * 0.034,
          rotation: 0.25,
          flatten: 0.78,
          hue: 32,
          arms: 0,
          elliptical: true,
        },
      ];
      staticCtx.globalCompositeOperation = "lighter";
      for (const galaxy of galaxies) paintGalaxy(staticCtx, galaxy, random);

      // Open and globular clusters with a handful of resolved bright members.
      const clusterSeeds: Array<[number, number, number, number]> = [
        [0.18, 0.34, 0.075, 202],
        [0.73, 0.67, 0.06, 224],
        [0.44, 0.82, 0.045, 274],
        [0.58, 0.12, 0.036, 44],
      ];
      clusters = clusterSeeds.map(([px, py, scale, hue]) => ({
        x: width * px,
        y: height * py,
        radius: smallest * scale,
        hue,
        stars: [],
      }));

      liveStars = [];
      clusters.forEach((cluster) => {
        paintNebula(staticCtx, cluster.x, cluster.y, cluster.radius * 1.4, cluster.radius * 1.4, 0, [110, 170, 255], 0.04);
        const count = Math.floor(52 + cluster.radius * 0.8);
        for (let index = 0; index < count; index += 1) {
          const angle = random() * TAU;
          const distance = Math.pow(random(), 0.7) * cluster.radius;
          const x = cluster.x + Math.cos(angle) * distance;
          const y = cluster.y + Math.sin(angle) * distance * (0.65 + random() * 0.35);
          const radius = 0.26 + Math.pow(random(), 3) * 1.35;
          const alpha = 0.18 + random() * 0.68;
          const star: Star = {
            x,
            y,
            radius,
            alpha,
            phase: random() * TAU,
            speed: 0.35 + random() * 0.9,
            hue: Math.floor(cluster.hue / 45 + random() * 3),
            depth: 0.6 + random() * 0.4,
          };
          cluster.stars.push(star);
          staticCtx.fillStyle = starColor(star.hue, alpha);
          staticCtx.beginPath();
          staticCtx.arc(x, y, radius, 0, TAU);
          staticCtx.fill();
          if (cluster.stars.length <= 120 && (random() > 0.82 || index < 6)) liveStars.push(star);
        }
        for (let index = 0; index < 4; index += 1) {
          const angle = random() * TAU;
          const distance = cluster.radius * (0.15 + random() * 0.55);
          paintBrightStar(staticCtx, {
            x: cluster.x + Math.cos(angle) * distance,
            y: cluster.y + Math.sin(angle) * distance * 0.7,
            radius: 0.8 + random() * 0.8,
            alpha: 0.8,
            phase: 0,
            speed: 1,
            hue: Math.floor(cluster.hue / 45),
            depth: 1,
          });
        }
      });

      // A loose foreground population, including a few navigation-grade stars.
      staticCtx.globalCompositeOperation = "lighter";
      for (let index = 0; index < 180; index += 1) {
        const x = random() * width;
        const y = random() * height;
        const radius = 0.3 + Math.pow(random(), 2.3) * 2.1;
        const alpha = 0.24 + random() * 0.68;
        const star: Star = {
          x,
          y,
          radius,
          alpha,
          phase: random() * TAU,
          speed: 0.25 + random() * 1.1,
          hue: Math.floor(random() * 6),
          depth: 0.7 + random() * 0.5,
        };
        staticCtx.fillStyle = starColor(star.hue, alpha);
        staticCtx.beginPath();
        staticCtx.arc(x, y, radius, 0, TAU);
        staticCtx.fill();
        if (index < 36) liveStars.push(star);
        if (index < 14) paintBrightStar(staticCtx, star, 0.9);
      }

      // A faint astral current connects a few bright anchors.
      staticCtx.globalCompositeOperation = "lighter";
      staticCtx.lineWidth = 0.5;
      for (let index = 0; index < 7; index += 1) {
        const start = liveStars[index * 5 + 3];
        const end = liveStars[index * 7 + 11];
        if (!start || !end) continue;
        staticCtx.strokeStyle = `hsla(${190 + index * 12}, 90%, 76%, 0.035)`;
        staticCtx.beginPath();
        staticCtx.moveTo(start.x, start.y);
        const midX = (start.x + end.x) / 2 + (random() - 0.5) * width * 0.08;
        const midY = (start.y + end.y) / 2 + (random() - 0.5) * height * 0.08;
        staticCtx.quadraticCurveTo(midX, midY, end.x, end.y);
        staticCtx.stroke();
      }
      staticCtx.globalCompositeOperation = "source-over";

      if (reduced) {
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(staticLayer, 0, 0, staticLayer.width, staticLayer.height, 0, 0, width, height);
      }
    };

    const spawnMeteor = () => {
      const fromLeft = Math.random() > 0.35;
      const startX = fromLeft ? -40 : Math.random() * width;
      const startY = fromLeft ? Math.random() * height * 0.55 : -30;
      const angle = fromLeft ? 0.35 + Math.random() * 0.3 : 1.08 + Math.random() * 0.2;
      const speed = 5.5 + Math.random() * 4.5;
      meteors.push({
        x: startX,
        y: startY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        max: 1,
        length: 60 + Math.random() * 110,
      });
      if (meteors.length > 3) meteors.shift();
    };

    const render = (timestamp: number) => {
      if (destroyed) return;
      raf = requestAnimationFrame(render);
      if (timestamp - lastFrame < 32) return;
      lastFrame = timestamp;
      time += 0.016;

      const targetX = pointer.active ? (pointer.tx / width - 0.5) * 2 : 0;
      const targetY = pointer.active ? (pointer.ty / height - 0.5) * 2 : 0;
      pointer.smoothX += (targetX - pointer.smoothX) * 0.035;
      pointer.smoothY += (targetY - pointer.smoothY) * 0.035;

      const driftX = Math.sin(time * 0.11) * 3.5;
      const driftY = Math.cos(time * 0.09) * 2.5;
      const offsetX = -14 + pointer.smoothX * -7 + driftX;
      const offsetY = -14 + pointer.smoothY * -5 + driftY;

      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(staticLayer, 0, 0, staticLayer.width, staticLayer.height, offsetX, offsetY, width + 28, height + 28);

      // Twinkling stars and cluster halos are the reactive foreground.
      ctx.globalCompositeOperation = "lighter";
      for (const star of liveStars) {
        const twinkle = 0.54 + Math.sin(time * star.speed + star.phase) * 0.3;
        const px = pointer.active ? pointer.x : width * 0.5;
        const py = pointer.active ? pointer.y : height * 0.5;
        const distance = Math.hypot(star.x - px, star.y - py);
        const reaction = pointer.active ? Math.max(0, 1 - distance / 330) : 0;
        const alpha = Math.min(0.95, star.alpha * (twinkle + reaction * 0.4));
        const radius = star.radius * (1 + reaction * 1.4);
        ctx.fillStyle = starColor(star.hue, alpha);
        ctx.beginPath();
        ctx.arc(star.x + offsetX, star.y + offsetY, radius, 0, TAU);
        ctx.fill();
        if (star.radius > 1.15 || reaction > 0.55) {
          ctx.fillStyle = starColor(star.hue, 0.07 + reaction * 0.12);
          ctx.beginPath();
          ctx.arc(star.x + offsetX, star.y + offsetY, radius * 7, 0, TAU);
          ctx.fill();
        }
      }

      if (pointer.active) {
        for (const cluster of clusters) {
          const distance = Math.hypot(cluster.x - pointer.x, cluster.y - pointer.y);
          if (distance > cluster.radius + 210) continue;
          const strength = Math.max(0, 1 - distance / (cluster.radius + 210));
          const glow = ctx.createRadialGradient(
            cluster.x + offsetX,
            cluster.y + offsetY,
            0,
            cluster.x + offsetX,
            cluster.y + offsetY,
            cluster.radius * 2.1,
          );
          glow.addColorStop(0, `hsla(${cluster.hue}, 90%, 78%, ${0.1 + strength * 0.1})`);
          glow.addColorStop(0.5, `hsla(${cluster.hue}, 90%, 68%, ${0.035 + strength * 0.05})`);
          glow.addColorStop(1, `hsla(${cluster.hue}, 90%, 60%, 0)`);
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(cluster.x + offsetX, cluster.y + offsetY, cluster.radius * 2.1, 0, TAU);
          ctx.fill();
        }

        const pointerGlow = ctx.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, 240);
        pointerGlow.addColorStop(0, "rgba(92, 190, 255, 0.045)");
        pointerGlow.addColorStop(0.5, "rgba(124, 104, 255, 0.018)");
        pointerGlow.addColorStop(1, "rgba(80, 160, 255, 0)");
        ctx.fillStyle = pointerGlow;
        ctx.fillRect(pointer.x - 240, pointer.y - 240, 480, 480);
      }

      if (pointer.active) {
        const pulse = 0.5 + Math.sin(time * 2.2) * 0.12;
        ctx.strokeStyle = `rgba(160, 220, 255, ${0.035 * pulse})`;
        ctx.lineWidth = 0.7;
        for (let ring = 0; ring < 2; ring += 1) {
          ctx.beginPath();
          ctx.arc(pointer.x, pointer.y, 22 + ring * 16 + Math.sin(time * 1.8 + ring) * 2, 0, TAU);
          ctx.stroke();
        }
      }

      nextMeteor -= 0.016;
      if (nextMeteor <= 0) {
        spawnMeteor();
        nextMeteor = 8 + Math.random() * 10;
      }
      for (const meteor of meteors) {
        meteor.x += meteor.vx;
        meteor.y += meteor.vy;
        meteor.life -= 0.012;
        if (meteor.life <= 0) continue;
        const tailX = meteor.x - meteor.vx * (meteor.length / 8);
        const tailY = meteor.y - meteor.vy * (meteor.length / 8);
        const trail = ctx.createLinearGradient(meteor.x, meteor.y, tailX, tailY);
        trail.addColorStop(0, `rgba(236, 252, 255, ${0.65 * meteor.life})`);
        trail.addColorStop(0.35, `rgba(150, 222, 255, ${0.2 * meteor.life})`);
        trail.addColorStop(1, "rgba(120, 190, 255, 0)");
        ctx.strokeStyle = trail;
        ctx.lineWidth = 1.15;
        ctx.beginPath();
        ctx.moveTo(meteor.x, meteor.y);
        ctx.lineTo(tailX, tailY);
        ctx.stroke();
        ctx.fillStyle = `rgba(245, 255, 255, ${0.8 * meteor.life})`;
        ctx.beginPath();
        ctx.arc(meteor.x, meteor.y, 1.2, 0, TAU);
        ctx.fill();
      }
      meteors = meteors.filter((meteor) => meteor.life > 0);

      ctx.globalCompositeOperation = "source-over";
    };

    const onPointer = (event: PointerEvent) => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.tx = event.clientX;
      pointer.ty = event.clientY;
      pointer.active = true;
    };
    const onLeave = () => {
      pointer.active = false;
    };

    build();
    if (reduced) {
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(staticLayer, 0, 0, staticLayer.width, staticLayer.height, 0, 0, width, height);
    } else {
      raf = requestAnimationFrame(render);
    }

    window.addEventListener("resize", build);
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("pointerleave", onLeave);

    return () => {
      destroyed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", build);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerleave", onLeave);
    };
  }, [reduced]);

  return (
    <div className={`backdrop${reduced ? " backdrop-reduced" : ""}`} aria-hidden="true">
      <canvas ref={canvasRef} />
      <div className="backdrop-grid" />
      <div className="backdrop-dust" />
      <div className="backdrop-scan" />
      <div className="backdrop-vignette" />
      <div className="backdrop-frame" />
    </div>
  );
}

import * as THREE from 'three';

const TAU = 2 * Math.PI;
const mix = (a, b, t) => a + (b - a) * t;
const unit = value => Math.max(0, Math.min(1, value));
const smooth = t => t * t * (3 - 2 * t);

function randomSource(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function hash(x, y, z) {
  const bits = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177);
  const mixed = Math.imul(bits ^ (bits >>> 13), 1274126177);
  return ((mixed ^ (mixed >>> 16)) >>> 0) / 4294967296;
}

// Sample in sphere direction so the procedural textures meet at the wrap seam.
function noise(x, y, z) {
  const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
  const u = smooth(x - i), v = smooth(y - j), w = smooth(z - k);
  return mix(
    mix(mix(hash(i, j, k), hash(i + 1, j, k), u), mix(hash(i, j + 1, k), hash(i + 1, j + 1, k), u), v),
    mix(mix(hash(i, j, k + 1), hash(i + 1, j, k + 1), u), mix(hash(i, j + 1, k + 1), hash(i + 1, j + 1, k + 1), u), v), w,
  );
}

function canvasMap(width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  const image = context.createImageData(width, height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) draw(image.data, (row * width + col) * 4, (col + .5) / width, (row + .5) / height);
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

function direction(u, v) {
  const azimuth = u * TAU, polar = v * Math.PI, ring = Math.sin(polar);
  return [-ring * Math.cos(azimuth), Math.cos(polar), ring * Math.sin(azimuth)];
}

function pixel(data, offset, r, g, b, a = 255) {
  data[offset] = r; data[offset + 1] = g; data[offset + 2] = b; data[offset + 3] = a;
}

export function solarSurface() {
  const spots = [direction(.70, .57), direction(.727, .602), direction(.18, .39), direction(.25, .67)];
  return canvasMap(512, 256, (data, offset, u, v) => {
    const [x, y, z] = direction(u, v);
    const granulation = noise(x * 105, y * 105, z * 105);
    const faculae = noise(x * 27 + 17, y * 27, z * 27) ** 2;
    const flow = noise(x * 9, y * 12, z * 9) + .22 * noise(x * 46, y * 58, z * 46);
    const brightness = unit(.23 + .28 * flow + .30 * granulation + .32 * faculae);
    let darkening = 0;
    for (const [i, [sx, sy, sz]] of spots.entries()) {
      const radius = i === 0 ? .067 : .045;
      const distance = Math.hypot(x - sx, y - sy, z - sz);
      darkening = Math.max(darkening, (1 - smooth(unit(distance * (1 + .32 * granulation) / radius))) * .69);
    }
    pixel(data, offset, (238 + 17 * brightness) * (1 - darkening), (106 + 123 * brightness) * (1 - 1.23 * darkening), (25 + 107 * brightness) * (1 - darkening));
  });
}

export function solarCorona() {
  return canvasMap(160, 160, (data, offset, u, v) => {
    const dx = 2 * u - 1, dy = 2 * v - 1;
    const radius = Math.hypot(dx, dy), angle = Math.atan2(dy, dx);
    const ripples = .5 + .5 * Math.sin(angle * 31 + Math.sin(angle * 7) * 3);
    const streamers = (.5 + .5 * Math.sin(angle * 7 + .65 * Math.cos(angle * 3))) ** 3;
    const fringe = Math.exp(-((radius - .406) ** 2) / .0025);
    const corona = Math.exp(-Math.max(0, radius - .40) * (15 - 5 * streamers));
    const edge = 1 - smooth(unit((radius - .7) / .3));
    const light = (.50 * fringe + (.19 + .23 * streamers + .11 * ripples) * corona) * edge;
    pixel(data, offset, 255, 100 + 76 * fringe, 25 + 49 * fringe, 255 * light);
  });
}

export function particleSurfaces() {
  const random = randomSource(109861);
  const craters = Array.from({ length: 45 }, (_, i) => ({
    direction: direction(random(), Math.acos(random() * 2 - 1) / Math.PI),
    radius: i < 7 ? .13 + .17 * random() : .023 + .10 * random() ** 2,
  }));
  const size = 384, height = size / 2;
  const relief = new Uint8ClampedArray(size * height);
  const color = canvasMap(size, height, (data, offset, u, v) => {
    const [x, y, z] = direction(u, v);
    const rock = noise(x * 32, y * 32, z * 32), grit = noise(x * 83, y * 83, z * 83);
    const terrain = noise(x * 4, y * 4, z * 4);
    let craterShade = 0, craterRelief = 0;
    for (const { direction: [cx, cy, cz], radius } of craters) {
      const distanceSquared = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2;
      if (distanceSquared > radius ** 2 * 1.6) continue;
      const r = Math.sqrt(distanceSquared) / radius + (rock - .5) * .10;
      const bowl = 1 - smooth(unit(r));
      const rim = Math.exp(-((r - .91) ** 2) / .009);
      craterRelief += .16 * rim - .36 * bowl;
      craterShade += 32 * rim - 35 * bowl;
    }
    const base = 57 + 64 * terrain + 24 * rock + 20 * grit + craterShade;
    relief[offset / 4] = 255 * unit(.45 * terrain + .40 * rock + .14 * grit + craterRelief);
    pixel(data, offset, base * 1.08, base * 1.01, base * .93);
  });
  const bump = canvasMap(size, height, (data, offset) => {
    const value = relief[offset / 4];
    pixel(data, offset, value, value, value);
  });
  return { color, bump };
}

export function solarMaterial(map) {
  return new THREE.ShaderMaterial({
    uniforms: { surface: { value: map } },
    toneMapped: false,
    vertexShader: `
      varying vec2 surfaceUV;
      varying vec3 surfaceNormal;
      varying vec3 towardCamera;
      void main() {
        surfaceUV = uv;
        surfaceNormal = normalMatrix * normal;
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        towardCamera = -viewPosition.xyz;
        gl_Position = projectionMatrix * viewPosition;
      }`,
    fragmentShader: `
      uniform sampler2D surface;
      varying vec2 surfaceUV;
      varying vec3 surfaceNormal;
      varying vec3 towardCamera;
      void main() {
        float mu = max(0.0, dot(normalize(surfaceNormal), normalize(towardCamera)));
        vec3 limb = mix(vec3(0.45, 0.24, 0.13), vec3(1.0), pow(mu, 0.52));
        gl_FragColor = vec4(limb * texture2D(surface, surfaceUV).rgb, 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

const bandNormal = new THREE.Vector3(.48, -.72, .50).normalize();
const bandAcross = new THREE.Vector3(0, 0, 1).cross(bandNormal).normalize();
const bandAlong = new THREE.Vector3().crossVectors(bandNormal, bandAcross);

export function skySurface() {
  return canvasMap(512, 256, (data, offset, u, v) => {
    const [x, y, z] = direction(u, v);
    const latitude = x * bandNormal.x + y * bandNormal.y + z * bandNormal.z;
    const cloud = .62 * noise(x * 8, y * 8, z * 8) + .26 * noise(x * 18, y * 18, z * 18) + .12 * noise(x * 42, y * 42, z * 42);
    const drift = (noise(x * 4, y * 4, z * 4) - .5) * .17;
    const belt = Math.exp(-((latitude + drift) ** 2) / .043);
    const dust = 1 - .65 * Math.exp(-((latitude + drift * 1.7) ** 2) / .0018);
    const density = belt * dust * smooth(cloud);
    pixel(data, offset, 5 + 32 * density, 9 + 37 * density, 20 + 54 * density);
  });
}

export function starField(pixelRatio) {
  const random = randomSource(982451653), count = 6700;
  const positions = new Float32Array(count * 3), colors = new Float32Array(count * 3), sizes = new Float32Array(count);
  const palette = ['#92bffa', '#cee1fc', '#f4f7ff', '#fdf1d8', '#ecc4a0'].map(value => new THREE.Color(value));
  for (let i = 0; i < count; i++) {
    const longitude = random() * TAU;
    const latitude = i < 3900 ? random() * 2 - 1 : (random() + random() - 1) * .32;
    const ring = Math.sqrt(1 - latitude ** 2), across = Math.cos(longitude) * ring, along = Math.sin(longitude) * ring;
    const index = i * 3;
    positions[index] = 101 * (across * bandAcross.x + along * bandAlong.x + latitude * bandNormal.x);
    positions[index + 1] = 101 * (across * bandAcross.y + along * bandAlong.y + latitude * bandNormal.y);
    positions[index + 2] = 101 * (across * bandAcross.z + along * bandAlong.z + latitude * bandNormal.z);
    const magnitude = random() ** 7, tint = palette[Math.floor(random() * palette.length)];
    const brightness = .12 + .81 * magnitude;
    colors.set([tint.r * brightness, tint.g * brightness, tint.b * brightness], index);
    sizes[i] = (1.1 + 3.8 * magnitude ** 2) * pixelRatio;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('starColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('starSize', new THREE.BufferAttribute(sizes, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    vertexShader: `
      attribute vec3 starColor;
      attribute float starSize;
      varying vec3 tint;
      void main() {
        tint = starColor;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = starSize;
      }`,
    fragmentShader: `
      varying vec3 tint;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        float light = (0.65 * exp(-15.0 * r * r) + 0.35 * exp(-80.0 * r * r)) * (1.0 - smoothstep(0.3, 0.5, r));
        gl_FragColor = vec4(tint, light);
        #include <colorspace_fragment>
      }`,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return points;
}

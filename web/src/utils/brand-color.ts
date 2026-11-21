export interface BrandPreset {
  id: string
  label: string
  color: string
}

export const DEFAULT_BRAND_COLOR = '#2f6f9f'

export const BRAND_PRESETS: BrandPreset[] = [
  { id: 'ocean', label: '海盐蓝', color: '#2f6f9f' },
  { id: 'indigo', label: '靛青', color: '#4f63b8' },
  { id: 'violet', label: '紫罗兰', color: '#7a5bb8' },
  { id: 'rose', label: '玫瑰', color: '#b04a6e' },
  { id: 'amber', label: '琥珀', color: '#b87324' },
  { id: 'teal', label: '青瓷', color: '#2f857c' },
  { id: 'forest', label: '森林绿', color: '#438d63' },
  { id: 'graphite', label: '石墨', color: '#4b5563' },
]

export interface BrandPalette {
  /** 主色（链接、文字强调、图标）。 */
  primary: string
  primaryHover: string
  primaryPressed: string
  /** 淡色背景。 */
  soft: string
  /** 实心填充（按钮、头像环）。 */
  fill: string
  fillHover: string
  fillPressed: string
  /** 填充上的文字色。 */
  onFill: string
  /** 用于 rgba(var(--ui-primary-rgb), alpha) 的逗号分隔 RGB。 */
  rgb: string
  /** 辅助色，用于图表和次级强调。 */
  secondary: string
  secondaryRgb: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function normalizeHex(input: unknown, fallback = DEFAULT_BRAND_COLOR): string {
  const raw = String(input || '').trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(raw))
    return raw
  if (/^#[0-9a-f]{3}$/.test(raw))
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`
  return fallback
}

export function hexToRgb(hex: string): { r: number, g: number, b: number } {
  const value = normalizeHex(hex).slice(1)
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  }
}

export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

export function rgbToHsl(r: number, g: number, b: number): { h: number, s: number, l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min)
    return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === rn)
    h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn)
    h = (bn - rn) / d + 2
  else
    h = (rn - gn) / d + 4
  return { h: h / 6, s, l }
}

export function hslToRgb(h: number, s: number, l: number): { r: number, g: number, b: number } {
  if (s === 0) {
    const v = Math.round(l * 255)
    return { r: v, g: v, b: v }
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    let next = t
    if (next < 0)
      next += 1
    if (next > 1)
      next -= 1
    if (next < 1 / 6)
      return p + (q - p) * 6 * next
    if (next < 1 / 2)
      return q
    if (next < 2 / 3)
      return p + (q - p) * (2 / 3 - next) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  }
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  const channel = (value: number) => {
    const n = value / 255
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

export function readableTextColor(background: string): string {
  return contrastRatio('#ffffff', background) >= 4.5 ? '#ffffff' : '#000000'
}

function shiftLightness(hex: string, delta: number): string {
  const { r, g, b } = hexToRgb(hex)
  const { h, s, l } = rgbToHsl(r, g, b)
  const next = hslToRgb(h, s, clamp(l + delta, 0, 1))
  return rgbToHex(next.r, next.g, next.b)
}

function shiftHue(hex: string, degrees: number, lightnessDelta = 0): string {
  const { r, g, b } = hexToRgb(hex)
  const { h, s, l } = rgbToHsl(r, g, b)
  const next = hslToRgb((h + degrees / 360 + 1) % 1, s, clamp(l + lightnessDelta, 0, 1))
  return rgbToHex(next.r, next.g, next.b)
}

function mixWithWhite(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex)
  const mix = (value: number) => Math.round(value + (255 - value) * amount)
  return rgbToHex(mix(r), mix(g), mix(b))
}

export function deriveBrandPalette(input: string, dark = false): BrandPalette {
  const base = normalizeHex(input)
  const { r, g, b } = hexToRgb(base)
  const { h, s, l } = rgbToHsl(r, g, b)
  const saturation = Math.min(s, dark ? 0.78 : 0.9)
  const lightness = dark ? clamp(l, 0.58, 0.82) : clamp(l, 0.28, 0.62)
  const next = hslToRgb(h, saturation, lightness)
  let primary = rgbToHex(next.r, next.g, next.b)
  const surface = dark ? '#303b47' : '#e8edf2'
  while (contrastRatio(primary, surface) < 4.5)
    primary = shiftLightness(primary, dark ? 0.03 : -0.03)

  const primaryRgb = hexToRgb(primary)
  const secondary = shiftHue(primary, 34, dark ? 0.02 : -0.02)
  const secondaryRgb = hexToRgb(secondary)
  const hover = shiftLightness(primary, dark ? 0.07 : -0.06)
  const pressed = shiftLightness(primary, dark ? 0.14 : -0.12)
  const fill = dark ? shiftLightness(primary, -0.12) : primary
  const fillHover = shiftLightness(fill, dark ? 0.05 : -0.06)
  const fillPressed = shiftLightness(fill, dark ? -0.05 : -0.12)
  const soft = dark
    ? `rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, 0.16)`
    : mixWithWhite(primary, 0.88)

  return {
    primary,
    primaryHover: hover,
    primaryPressed: pressed,
    soft,
    fill,
    fillHover,
    fillPressed,
    onFill: readableTextColor(fill),
    rgb: `${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}`,
    secondary,
    secondaryRgb: `${secondaryRgb.r}, ${secondaryRgb.g}, ${secondaryRgb.b}`,
  }
}

export function presetIdForColor(color: string): string {
  const normalized = normalizeHex(color)
  return BRAND_PRESETS.find(preset => preset.color.toLowerCase() === normalized)?.id || 'custom'
}

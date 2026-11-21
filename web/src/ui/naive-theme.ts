import type { GlobalThemeOverrides } from 'naive-ui'
import { DEFAULT_BRAND_COLOR, deriveBrandPalette, readableTextColor } from '@/utils/brand-color'

/** 深色模式下的通用色，与 style.css 中 .dark 的 --ui-* 变量保持一致。 */
function createDarkCommon(brandColor: string) {
  const palette = deriveBrandPalette(brandColor, true)
  return {
    // 深色下字重统一减 40，避免浅色字在深底上发胖。
    fontWeight: '360',
    fontWeightStrong: '560',
    primaryColor: palette.primary,
    primaryColorHover: palette.primaryHover,
    primaryColorPressed: palette.primaryPressed,
    primaryColorSuppl: palette.primaryHover,
    infoColor: '#82b6d6',
    successColor: '#4bbd86',
    warningColor: '#e2ab5f',
    errorColor: '#ee858b',
    bodyColor: '#111418',
    cardColor: '#1a1f25',
    modalColor: '#1a1f25',
    popoverColor: '#20262d',
    inputColor: '#161a20',
    tableColor: 'transparent',
    tableHeaderColor: '#20262d',
    textColorBase: '#e4e8ec',
    textColor1: '#e4e8ec',
    textColor2: '#a3acb6',
    textColor3: '#78818c',
    placeholderColor: '#6b747f',
    borderColor: 'rgba(255, 255, 255, 0.09)',
    dividerColor: 'rgba(255, 255, 255, 0.07)',
    hoverColor: 'rgba(255, 255, 255, 0.06)',
    boxShadow1: '0 1px 3px rgba(0, 0, 0, 0.32)',
    boxShadow2: '0 8px 24px rgba(0, 0, 0, 0.36)',
    boxShadow3: '0 20px 56px rgba(0, 0, 0, 0.48)',
  }
}

export function createNaiveThemeOverrides(dark = false, brandColor = DEFAULT_BRAND_COLOR): GlobalThemeOverrides {
  const light = createLightOverrides(brandColor)
  if (!dark)
    return light
  const palette = deriveBrandPalette(brandColor, true)
  return {
    ...light,
    common: { ...light.common, ...createDarkCommon(brandColor) },
    Tabs: { ...light.Tabs, tabColorSegment: '#242a32' },
    DataTable: {
      borderColor: 'rgba(255, 255, 255, 0.07)',
      thColor: '#20262d',
      thColorHover: '#262c34',
      tdColorHover: 'rgba(255, 255, 255, 0.03)',
    },
    Button: {
      ...light.Button,
      fontWeight: '560',
      colorWarning: '#b9813a',
      colorHoverWarning: '#c58d45',
      colorPressedWarning: '#a67331',
      colorFocusWarning: '#c58d45',
      borderWarning: '1px solid #b9813a',
      borderHoverWarning: '1px solid #c58d45',
      borderPressedWarning: '1px solid #a67331',
      borderFocusWarning: '1px solid #c58d45',
      colorError: '#c4545c',
      colorHoverError: '#cf626a',
      colorPressedError: '#b04850',
      colorFocusError: '#cf626a',
      borderError: '1px solid #c4545c',
      borderHoverError: '1px solid #cf626a',
      borderPressedError: '1px solid #b04850',
      borderFocusError: '1px solid #cf626a',
      ...primaryButtonColors(palette),
      textColorSuccess: '#ffffff',
      textColorHoverSuccess: '#ffffff',
      textColorPressedSuccess: '#ffffff',
      textColorFocusSuccess: '#ffffff',
      textColorWarning: '#ffffff',
      textColorHoverWarning: '#ffffff',
      textColorPressedWarning: '#ffffff',
      textColorFocusWarning: '#ffffff',
      textColorError: '#ffffff',
      textColorHoverError: '#ffffff',
      textColorPressedError: '#ffffff',
      textColorFocusError: '#ffffff',
      textColorInfo: '#ffffff',
      textColorHoverInfo: '#ffffff',
      textColorPressedInfo: '#ffffff',
      textColorFocusInfo: '#ffffff',
    },
    Switch: {
      ...light.Switch,
      railColorActive: palette.primary,
      boxShadowFocus: `0 0 0 3px rgba(${palette.rgb}, 0.22)`,
    },
    Modal: { boxShadow: '0 24px 64px rgba(0, 0, 0, 0.45)' },
  }
}

function primaryButtonColors(palette: ReturnType<typeof deriveBrandPalette>) {
  return {
    colorPrimary: palette.fill,
    colorHoverPrimary: palette.fillHover,
    colorPressedPrimary: palette.fillPressed,
    colorFocusPrimary: palette.fillHover,
    textColorPrimary: palette.onFill,
    textColorHoverPrimary: readableTextColor(palette.fillHover),
    textColorPressedPrimary: readableTextColor(palette.fillPressed),
    textColorFocusPrimary: readableTextColor(palette.fillHover),
  }
}

function createLightOverrides(brandColor: string): GlobalThemeOverrides {
  const palette = deriveBrandPalette(brandColor, false)
  return {
    common: {
      primaryColor: palette.primary,
      primaryColorHover: palette.primaryHover,
      primaryColorPressed: palette.primaryPressed,
      primaryColorSuppl: palette.secondary,
      infoColor: palette.secondary,
      successColor: '#2f9e6e',
      warningColor: '#c58b3f',
      errorColor: '#c95f66',
      bodyColor: '#f7f8f9',
      cardColor: 'rgba(255, 255, 255, 0.84)',
      modalColor: 'rgba(255, 255, 255, 0.96)',
      popoverColor: 'rgba(255, 255, 255, 0.96)',
      inputColor: 'rgba(255, 255, 255, 0.78)',
      tableColor: 'transparent',
      tableHeaderColor: 'rgba(238, 241, 244, 0.9)',
      textColorBase: '#1f2933',
      textColor1: '#1f2933',
      textColor2: '#667085',
      textColor3: '#98a2b3',
      borderColor: 'rgba(31, 41, 51, 0.12)',
      dividerColor: 'rgba(31, 41, 51, 0.09)',
      borderRadius: '8px',
      borderRadiusSmall: '6px',
      heightSmall: '32px',
      heightMedium: '38px',
      heightLarge: '42px',
      fontFamily: 'Inter, "Microsoft YaHei", "PingFang SC", ui-sans-serif, system-ui, sans-serif',
      fontFamilyMono: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
      fontWeight: '400',
      fontWeightStrong: '600',
      boxShadow1: '0 2px 10px rgba(31, 41, 51, 0.05)',
      boxShadow2: '0 12px 32px rgba(31, 41, 51, 0.08)',
      boxShadow3: '0 24px 64px rgba(31, 41, 51, 0.12)',
    },
    Button: {
      heightSmall: '32px',
      heightMedium: '38px',
      heightLarge: '42px',
      borderRadiusSmall: '9px',
      borderRadiusMedium: '10px',
      borderRadiusLarge: '11px',
      fontSizeSmall: '13px',
      fontSizeMedium: '14px',
      fontSizeLarge: '15px',
      fontWeight: '600',
      ...primaryButtonColors(palette),
    },
    Input: {
      heightSmall: '32px',
      heightMedium: '38px',
      heightLarge: '42px',
      borderRadius: '10px',
    },
    Select: {
      peers: {
        InternalSelection: {
          borderRadius: '10px',
        },
      },
    },
    Card: {
      borderRadius: '8px',
      titleFontWeight: '600',
      boxShadow: '0 10px 30px rgba(31, 41, 51, 0.06)',
    },
    Tabs: {
      tabColorSegment: 'rgba(238, 241, 244, 0.9)',
      tabBorderRadius: '10px',
      tabFontWeightActive: '600',
    },
    DataTable: {
      borderColor: 'rgba(31, 41, 51, 0.1)',
      thColor: 'rgba(238, 241, 244, 0.9)',
      thColorHover: 'rgba(233, 237, 241, 0.96)',
      tdColorHover: 'rgba(244, 246, 248, 0.8)',
    },
    Dialog: {
      borderRadius: '12px',
    },
    Modal: {
      boxShadow: '0 24px 64px rgba(31, 41, 51, 0.14)',
    },
    Switch: {
      railColorActive: palette.primary,
      boxShadowFocus: `0 0 0 3px rgba(${palette.rgb}, 0.16)`,
    },
  }
}

// Author: Jeff.Liu. Extracted JSX/callback fixtures share the real English locale, not a fake translator.
import {t,i18n,setLocale} from '../../src/i18n.ts';
import * as preferences from '../../src/app-preferences.ts';
import {applyAppThemeDocument,applyAppTerminalTheme} from '../../src/app-themes.ts';
Object.assign(globalThis,{t,i18n,setLocale,...preferences,applyAppThemeDocument,applyAppTerminalTheme});

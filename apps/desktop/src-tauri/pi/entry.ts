// Author: Jeff.Liu. Pi supplies its own model capability and credential handling.
import {getSupportedThinkingLevels} from '@earendil-works/pi-ai/models';
import install from './router.mjs';
export default function(pi) { return install(pi,getSupportedThinkingLevels); }

// The guide in its own page (WP7.5, D4): what a program is and what it may do — the SDK's README
// rendered at build time — and the numbers this machine holds a program to. Linked from the top
// of the editor as "What is a program?".
import { guideMarkdown, limitsSentence, renderGuide } from "./editor-core.ts";

const body = document.querySelector<HTMLDivElement>("#guideBody");
const limits = document.querySelector<HTMLParagraphElement>("#guideLimits");
if (body && body.childElementCount === 0) body.append(renderGuide(guideMarkdown()));
if (limits) limits.textContent = limitsSentence();

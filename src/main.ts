/**
 * Entry point. Boots the instrument on the hardware faceplate.
 */
import { App } from './ui/app';

const root = document.getElementById('stage') as HTMLElement;
const app = new App(document.body);
void app.boot();

// keep the platform preview happy: expose a tiny debug handle
(window as any).groovebox = app;
void root;

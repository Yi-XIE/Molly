import type { MollyDesktopApi } from '../../preload/index';

declare global {
  interface Window {
    molly: MollyDesktopApi;
  }
}

export {};

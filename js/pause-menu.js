// The pause screen. A native modal <dialog> handles the focus trap and keeps the page behind it inert;
// main.js decides what pausing freezes through onOpen / onClose.

class PauseMenu {
  constructor({ onOpen, onClose } = {}) {
    this.root = document.getElementById('pause-menu');
    this.resumeButton = document.getElementById('pause-resume');
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.isOpen = false;

    this.resumeButton?.addEventListener('click', () => this.close());
    // Esc goes through close() so the game resumes with it, not only the dialog
    this.root?.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.close();
    });
  }

  open() {
    if (this.isOpen || !this.root) return;
    this.isOpen = true;
    this.onOpen?.();
    this.root.showModal();
    this.resumeButton?.focus();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.close();
    this.onClose?.();
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }
}

export { PauseMenu };

// COPY buttons on the calibration slips. The clipboard API needs a secure context; elsewhere the
// command is selected so it can be copied by hand.
export function initCopy() {
  const status = document.getElementById("copy-status");
  for (const button of document.querySelectorAll("[data-copy]")) {
    let timer = 0;
    button.addEventListener("click", async () => {
      const code = document.getElementById(button.dataset.copy);
      if (!code) return;
      let ok = false;
      try {
        // the slips set no-break spaces and break points for wrapping; the shell wants plain spaces
        await navigator.clipboard.writeText(code.textContent.replace(/\u00a0/g, " "));
        ok = true;
      } catch {
        ok = select(code);
      }
      const word = button.querySelector(".copy__word");
      word.textContent = ok ? "Copied" : "Selected";
      button.classList.toggle("is-done", ok);
      if (status) status.textContent = ok ? "Copied to the clipboard." : "Couldn't reach the clipboard. The command is selected; copy it with your keyboard.";
      clearTimeout(timer);
      timer = setTimeout(() => {
        word.textContent = "Copy";
        button.classList.remove("is-done");
        if (status) status.textContent = "";
      }, 2400);
    });
  }
}

function select(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return false;
}

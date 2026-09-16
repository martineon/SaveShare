window.worldNotice.onMessage(message => { document.getElementById('message').textContent = message; });
document.getElementById('open').onclick = () => window.worldNotice.open();
document.getElementById('close').onclick = () => window.worldNotice.close();

let diagnosticWorld = null, diagnosticPending = false;
async function openDiagnostics(worldId) {
  if (diagnosticPending) return;
  diagnosticWorld = worldId; diagnosticPending = true;
  const dialog = $('diagnostics');
  if (!dialog.open) dialog.showModal();
  $('diagnostic-result').hidden = true;
  $('diagnostic-progress').textContent = 'Vérification du serveur, du chemin et des empreintes… Aucun fichier ne sera modifié.';
  $('copy-diagnostic').disabled = true; $('rerun-diagnostic').disabled = true;
  try {
    const result = await api.diagnoseWorld(worldId);
    $('diagnostic-progress').textContent = `Vérifié le ${new Date(result.generatedAt).toLocaleString('fr-FR')} · ${result.checks.filter(c => c.level === 'error' || c.level === 'warning').length} point(s) à vérifier.`;
    const fields = [
      ['Dossier configuré', result.paths.configured], ['Destination des fichiers', result.paths.destination], ['Chemin local habituel (indicatif)', result.paths.usual],
      ['Version locale enregistrée', result.versions.local], ['Version sur le serveur', result.versions.remote], ['Format', result.versions.format]
    ];
    $('diagnostic-paths').innerHTML = fields.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('');
    const labels = { ok: 'OK', warning: 'À VÉRIFIER', error: 'ERREUR', info: 'INFO' };
    $('diagnostic-checks').innerHTML = result.checks.map(c => `<section class="diagnostic-check ${esc(c.level)}"><span>${labels[c.level]}</span><div><strong>${esc(c.title)}</strong><p>${esc(c.detail)}</p></div></section>`).join('');
    $('diagnostic-report').textContent = result.report;
    $('diagnostic-result').hidden = false; $('copy-diagnostic').disabled = false;
  } catch (e) { $('diagnostic-progress').textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
  finally { diagnosticPending = false; $('rerun-diagnostic').disabled = false; }
}
$('close-diagnostic').onclick = () => $('diagnostics').close();
$('rerun-diagnostic').onclick = () => openDiagnostics(diagnosticWorld);
$('copy-diagnostic').onclick = async () => {
  try { toast(await api.copyDiagnostic(diagnosticWorld)); }
  catch (e) { toast(e.message); }
};

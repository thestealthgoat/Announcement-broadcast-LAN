// The tray's "Reset admin password" flow. Electron's dialog and clipboard are
// passed in so this can be tested without a display.
export async function runRecoveryFlow({ server, dialog, clipboard }) {
  const admins = server.listAdmins();
  if (!admins.length) {
    await dialog.showMessageBox({
      type: 'info',
      buttons: ['OK'],
      message: 'There are no admin accounts yet.',
      detail: 'Open the admin page to finish setup.',
    });
    return;
  }

  const buttons = [...admins.map((a) => `${a.name} (${a.username})`), 'Cancel'];
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons,
    cancelId: buttons.length - 1,
    defaultId: buttons.length - 1,
    message: 'Reset which admin password?',
    detail: 'This replaces the password with a temporary one and signs that person out everywhere. TVs keep playing.',
  });
  const admin = admins[response];
  if (!admin) return;

  const temp = await server.resetAdminPassword(admin.id);
  const done = await dialog.showMessageBox({
    type: 'info',
    buttons: ['Copy password', 'Close'],
    defaultId: 0,
    cancelId: 1,
    message: `Password reset for ${admin.username}`,
    detail: `Temporary password:\n\n${temp}\n\nSign in with it, then change it under Settings. It won't be shown again.`,
  });
  if (done.response === 0) clipboard.writeText(temp);
}

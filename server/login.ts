// OPTIONAL standalone login. The main flow is now the UI button "Войти в
// Piano Marvel" (see App.vue) — start the app with `bun run dev` and log in
// there. This CLI stays for headless/manual use: it opens a real, visible
// Chrome window so you can sign in by hand (your password never passes through
// this code), then persists the session to .browser-profile/.
//
// NOTE: don't run this while `bun run dev` is running — a persistent profile
// can only be opened by one process at a time.
import { startLogin, isLoggedIn, getLoginState, closeContext } from "./browser"; // CHANGED: new shared API

async function main() {
  console.log("Открылось отдельное окно обычного Chrome.");
  console.log("Войдите через Google, дождитесь Piano Marvel и закройте это окно.");

  await startLogin(); // CHANGED: opens the shared headed browser at /login

  const deadline = Date.now() + 5 * 60 * 1000; // give up after 5 minutes
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    if (getLoginState() === "loggedIn" || (await isLoggedIn())) {
      console.log("Готово — сессия сохранена в .browser-profile/.");
      await closeContext();
      return;
    }
  }

  console.log("Не дождался входа за 5 минут — запустите `bun run login` ещё раз.");
  await closeContext();
}

main().catch(async (err) => {
  console.error(err);
  await closeContext(); // CHANGED: clean up the window on error
  process.exit(1);
});

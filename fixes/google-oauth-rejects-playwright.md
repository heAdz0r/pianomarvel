# Google OAuth отклоняет браузер Playwright

## Проблема

При входе в Piano Marvel через Google открывалась страница
`accounts.google.com/.../signin/rejected` с сообщением, что браузер или
приложение небезопасны.

## Причина

Google OAuth определял управляемый Playwright Chromium. Это ограничение Google,
а не ошибка учётной записи Piano Marvel.

## Решение

Вход разделён на две фазы:

1. `server/browser.ts` закрывает управляемый контекст и запускает обычный
   установленный Google Chrome с отдельным профилем `.browser-profile/`.
2. Пользователь вручную проходит Google OAuth и нажимает в загрузчике
   «Я вошёл — проверить».
3. Приложение завершает отдельный процесс и открывает тот же профиль через
   Playwright с `channel: "chrome"`. Флаги `--use-mock-keychain` и
   `--password-store=basic` исключены, поэтому cookies расшифровываются через
   тот же системный Keychain, что и в обычном Chrome.

Пароль и OAuth-токены не передаются коду приложения. Флаги
`--enable-automation` и `--remote-debugging` на этапе входа не используются.

## Проверка

- `bun test server/browser.test.ts`
- `bun run typecheck`
- Ручной вход через Google и закрытие отдельного окна Chrome.

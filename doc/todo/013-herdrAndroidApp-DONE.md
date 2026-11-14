> Run with: Opus 5.5 / high
> Machine: mac

# Herdr android app

## Original Requirement

[NEVER REMOVE]

What ip address, username password and port?

_From Kanban card `33e9f434-c738-4c8b-a20b-82680ac3b57d`, moved to the agent list._

_GitHub issue #13 — end the commit subject with `(#13)`._

## Results

**Summary** — The answer, for [herdr-android](https://github.com/makefunstuff/herdr-android/releases/latest)
(the official Herdr app cannot see runner panes, see #11). All three machines run Herdr TUI
0.9.5, and sshd accepts both keys and passwords.

| Machine | Address (Tailscale)                                            | Port | Username  |
| ------- | -------------------------------------------------------------- | ---- | --------- |
| Mac     | `kaspar-mac-mini` / `100.68.52.4`                              | 22   | `klarity` |
| karel   | `sentry` / `100.80.192.73`                                     | 9812 | `krl`     |
| dell    | no Tailscale: **Connect through** karel, or the home public IP | 22   | `ppa`     |

- **Password**: the machine's login password for that user. I do not know these and will not
  put them in a public repo. Better: in the app, copy its public key (**Settings**) and add it
  to `~/.ssh/authorized_keys` for that user. Then no password is needed.
- **Tailscale on the phone**: the tailnet shows `kaspars-s23-ultra` offline for 142 days.
  Turn the Tailscale app on, or the `100.x` addresses and names above do not answer.
- **Without Tailscale**: karel and dell are also reachable on the home public IP (karel on
  port 9812, dell on 22). That IP is the `HostName` for `karel` in the Mac's `~/.ssh/config`,
  left out here because this repo is public. The Mac has no public route.
- Machine names: karel's Tailscale name is `sentry`, not `karel`.

**Files changed** — modified and renamed this file to `-DONE.md`. No code.

**Verification** — `tailscale status` on the Mac and karel; `sshd -T` on karel and dell, the
sshd config and `com.apple.access_ssh` on the Mac; `herdr --version` on the Mac and karel,
the binary on dell. All over SSH from the Mac. Not tried from the phone.

**Deviations** — None. A question, answered; Backlog 013 (`runnerOnHerdrCore`) stays as is.

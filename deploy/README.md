# Running szigzug.hu on the netcup VPS

This guide sets up the site on the **netcup VPS 1000 G12 (Debian 12 or 13)** with the domain at **Rackhost**, turns on **HTTPS**, and shows the two ways to update the site from GitHub: **automatically** (GitHub Actions) or **manually** (one command).

```
Browser ──HTTPS──▶ nginx (ports 80/443) ──▶ Node.js app (127.0.0.1:3000) ──▶ SQLite (/var/lib/szigzug/szigzug.db)
```

| What | Where on the server |
| --- | --- |
| Code (a git clone of this repository) | `/opt/szigzug` |
| Database | `/var/lib/szigzug/szigzug.db` |
| Backups | `/var/backups/szigzug` |
| Settings (environment) | `/etc/szigzug/szigzug.env` |
| App service | `szigzug.service` (systemd) |

Commands below are run on the server over SSH (`ssh root@62.83.9.130`, or your own user with `sudo`). Where a command contains `YOUR_EMAIL` or a key, replace it with your own value.

---

## 0. Prepare the server

```bash
cat /etc/os-release                      # should say Debian 12 (bookworm) or 13 (trixie)
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y git curl nginx ufw certbot
```

## 1. DNS at Rackhost (check it)

On 14 September 2026 both names already pointed to the VPS:

| Name | Type | Value |
| --- | --- | --- |
| `szigzug.hu` | A | `62.83.9.130` |
| `www.szigzug.hu` | A (or CNAME to `szigzug.hu`) | `62.83.9.130` |

Check it again from any computer:

```bash
dig +short szigzug.hu A          # 62.83.9.130
dig +short www.szigzug.hu A      # 62.83.9.130
dig +short szigzug.hu AAAA       # should be empty (see below)
dig +short szigzug.hu CAA        # empty, or must include letsencrypt.org
```

(On Windows without `dig`: `nslookup szigzug.hu` and `nslookup -type=AAAA szigzug.hu`.)

- **AAAA (IPv6):** leave it empty unless you want IPv6. If you add one, it must be exactly the VPS's IPv6 address from the netcup control panel. Let's Encrypt prefers IPv6, and a wrong AAAA record is the most common reason certificates fail.
- **CAA:** if Rackhost shows a CAA record, it must allow `letsencrypt.org`.
- DNS changes can take up to the record's TTL (often an hour) to spread.

## 2. Firewall

```bash
sudo ufw allow OpenSSH           # FIRST, or you lock yourself out
sudo ufw allow 'Nginx Full'      # ports 80 and 443
sudo ufw enable
sudo ufw status
```

If you ever lock yourself out, use the VNC console in the netcup Server Control Panel.

## 3. Install Node.js and the app

```bash
# Node.js 24 LTS from NodeSource (Debian's own nodejs package is too old for node:sqlite)
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
sudo bash /tmp/nodesource_setup.sh
sudo apt install -y nodejs
node --version                   # v24.x

# A dedicated user, the code and the data directories
sudo adduser --system --group --home /home/szigzug --shell /bin/bash szigzug
sudo install -d -o szigzug -g szigzug -m 755 /opt/szigzug
sudo install -d -o szigzug -g szigzug -m 750 /var/lib/szigzug /var/backups/szigzug
sudo -u szigzug git clone https://github.com/RobinCodes/DOK.git /opt/szigzug
sudo -u szigzug bash -c 'cd /opt/szigzug && npm test'      # every test must pass

# Settings and the service
sudo install -d -m 755 /etc/szigzug
sudo install -m 600 /opt/szigzug/deploy/szigzug.env.example /etc/szigzug/szigzug.env
sudo cp /opt/szigzug/deploy/systemd/szigzug.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now szigzug
systemctl status szigzug --no-pager
curl http://127.0.0.1:3000/healthz                          # prints: ok
```

> **If the repository is private:** create a read-only deploy key for the server and clone over SSH instead:
> ```bash
> sudo -u szigzug ssh-keygen -t ed25519 -N "" -f /home/szigzug/.ssh/github_read
> sudo cat /home/szigzug/.ssh/github_read.pub
> ```
> Add that public key in GitHub → *Settings → Deploy keys* (leave "Allow write access" off), then:
> ```bash
> printf 'Host github.com\n  IdentityFile ~/.ssh/github_read\n' | sudo -u szigzug tee -a /home/szigzug/.ssh/config
> sudo -u szigzug git clone git@github.com:RobinCodes/DOK.git /opt/szigzug
> ```

## 4. Accounts

Accounts exist only on the console, never through the website. Install the shortcut once:

```bash
sudo install -m 755 /opt/szigzug/deploy/szigzug-users /usr/local/bin/szigzug-users
```

Then create accounts. The password is typed twice without being shown, and must be at least 10 characters.

```bash
sudo szigzug-users create robin    --name "Rovenszky Robin" --role superadmin
sudo szigzug-users create bence    --name "Tornai Bence"                   # organizer (admin)
sudo szigzug-users create zsofi    --name "Nagy Zsófi"      --role logadmin
sudo szigzug-users create kaszino1 --name "Császár Domonkos" --casino       # casino staff
sudo szigzug-users list
```

| Command | Does |
| --- | --- |
| `create <user> --name "Name" [--role admin\|logadmin\|superadmin] [--casino] [--class 9.A]` | new account (`--class` works once classes exist) |
| `passwd <user>` | new password; logs the user out everywhere |
| `role <user> <role>` | change the level |
| `casino <user> on\|off` | casino staff or not |
| `disable <user>` / `enable <user>` | lock / unlock an account |
| `list` | all accounts |

The superadmin can also change roles, casino flag, own class and budgets in the web panel (*Szuperadmin → Fiókok*), but passwords only here.

## 5. HTTPS (Let's Encrypt)

Your server currently answers on plain HTTP with a test page. First find and disable that config, so it doesn't compete with the new one:

```bash
grep -rl "server_name\|listen" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/
sudo rm -f /etc/nginx/sites-enabled/default      # plus any other file the grep showed for this site
```

**5a. A temporary HTTP config** that can answer Let's Encrypt's check:

```bash
sudo install -d -m 755 /var/www/letsencrypt
sudo cp /opt/szigzug/deploy/nginx/szigzug.hu.http-only.conf /etc/nginx/sites-available/szigzug.hu
sudo ln -sf /etc/nginx/sites-available/szigzug.hu /etc/nginx/sites-enabled/szigzug.hu
sudo nginx -t && sudo systemctl reload nginx
curl -I http://szigzug.hu                         # HTTP/1.1 200 OK (the new site)
```

**5b. Get the certificate** (covers both names; you accept Let's Encrypt's terms with `--agree-tos`):

```bash
sudo certbot certonly --webroot -w /var/www/letsencrypt \
  -d szigzug.hu -d www.szigzug.hu \
  --email YOUR_EMAIL --agree-tos --no-eff-email
```

**5c. The final HTTPS config:**

```bash
sudo cp /opt/szigzug/deploy/nginx/szigzug-proxy.conf /etc/nginx/snippets/szigzug-proxy.conf
sudo cp /opt/szigzug/deploy/nginx/szigzug.hu.conf /etc/nginx/sites-available/szigzug.hu
sudo nginx -t && sudo systemctl reload nginx
```

**5d. Automatic renewal.** Debian's certbot package already renews twice a day with a systemd timer; nginx just has to reload afterwards:

```bash
systemctl list-timers | grep certbot
printf '#!/bin/sh\nsystemctl reload nginx\n' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx
sudo certbot renew --dry-run                      # must end with "Congratulations, all simulated renewals succeeded"
```

**5e. Check:**

```bash
curl -I http://szigzug.hu          # 301 → https://szigzug.hu/
curl -I https://www.szigzug.hu     # 301 → https://szigzug.hu/
curl -I https://szigzug.hu         # 200, with a strict-transport-security header
```

Optionally test the grade at <https://www.ssllabs.com/ssltest/analyze.html?d=szigzug.hu>.

**5f. Later:** after a week without problems, change `max-age=86400` to `max-age=31536000` in both places in `/etc/nginx/sites-available/szigzug.hu`, then `sudo nginx -t && sudo systemctl reload nginx`.

> The app sets `Secure` cookies (`COOKIE_SECURE=1`), so **logging in only works over https://**. If you want to try the admin before HTTPS works, temporarily set `COOKIE_SECURE=0` in `/etc/szigzug/szigzug.env`, `sudo systemctl restart szigzug`, and set it back afterwards.

## 6. First look

1. Open <https://szigzug.hu>: the event page (in Hungarian, or English if your browser is set to another language).
2. Open <https://szigzug.hu/admin> and log in as the superadmin.
3. *Szuperadmin → Osztályok*: add the classes. Then go through the checklist at the end.

## 7. Backups

An hourly backup that keeps the last 168 (one week):

```bash
sudo cp /opt/szigzug/deploy/systemd/szigzug-backup.service /opt/szigzug/deploy/systemd/szigzug-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now szigzug-backup.timer
sudo systemctl start szigzug-backup.service
journalctl -u szigzug-backup -n 5 --no-pager      # "Backup written" and "Event log OK ... last hash ..."
ls -l /var/backups/szigzug
```

Every backup also verifies the event log's hash chain and prints the latest hash. Copying backups off the server now and then (for example after every program) protects against losing the whole VPS. On your own computer:

```bash
scp root@62.83.9.130:/var/backups/szigzug/szigzug-*.db .
```

**Restoring a backup** (in this order, the old `-wal`/`-shm` files must go before starting):

```bash
sudo systemctl stop szigzug
sudo rm -f /var/lib/szigzug/szigzug.db-wal /var/lib/szigzug/szigzug.db-shm
sudo -u szigzug cp /var/backups/szigzug/szigzug-2026-09-18T18-00-00-000Z.db /var/lib/szigzug/szigzug.db
sudo systemctl start szigzug
```

## 8. Updating the site from GitHub

`deploy/deploy.sh` does a safe update: it fetches the code, **runs the full test suite on the server**, backs up the database, restarts the app, checks that it answers, and **goes back to the previous version** automatically if any of that fails.

Allow the `szigzug` user to restart its own service (once):

```bash
sudo install -m 440 /opt/szigzug/deploy/sudoers-szigzug /etc/sudoers.d/szigzug
sudo visudo -c                                     # must say "parsed OK"
```

### 8a. Manually

After pushing to GitHub:

```bash
ssh root@62.83.9.130
sudo -u szigzug bash /opt/szigzug/deploy/deploy.sh               # newest main
sudo -u szigzug bash /opt/szigzug/deploy/deploy.sh 1a2b3c4       # or a specific commit (e.g. to go back)
```

### 8b. Automatically with GitHub Actions

Every push to `main` runs the tests on GitHub (Node 22 and 24). When they pass, GitHub logs in to the server with a key that is **only able to run the deploy script** and nothing else.

1. **On your own computer**, create a key pair used only for this:
   ```bash
   ssh-keygen -t ed25519 -N "" -C "github-actions-deploy" -f szigzug_deploy
   ```
   This makes `szigzug_deploy` (private) and `szigzug_deploy.pub` (public).

2. **On the server**, allow that key to run the deploy script and nothing else (paste the whole content of `szigzug_deploy.pub` where it says `ssh-ed25519 AAAA...`):
   ```bash
   sudo install -d -o szigzug -g szigzug -m 700 /home/szigzug/.ssh
   echo 'restrict,command="bash /opt/szigzug/deploy/deploy.sh" ssh-ed25519 AAAA...your-public-key... github-actions-deploy' \
     | sudo tee -a /home/szigzug/.ssh/authorized_keys
   sudo chown szigzug:szigzug /home/szigzug/.ssh/authorized_keys
   sudo chmod 600 /home/szigzug/.ssh/authorized_keys
   ```

3. **Test it from your computer.** It should print the deploy steps and disconnect:
   ```bash
   ssh -i szigzug_deploy szigzug@62.83.9.130
   ```

4. **Get the server's host key** (so GitHub can be sure it talks to your server):
   ```bash
   ssh-keyscan -t ed25519 62.83.9.130
   ```
   To be safe, compare its fingerprint with the one on the server: `ssh-keyscan -t ed25519 62.83.9.130 | ssh-keygen -lf -` on your computer versus `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server.

5. **In GitHub**: repository → *Settings → Secrets and variables → Actions*.
   - *Secrets* tab → *New repository secret*:
     - `DEPLOY_HOST` = `62.83.9.130`
     - `DEPLOY_SSH_KEY` = the whole content of the private key file `szigzug_deploy`
     - `DEPLOY_KNOWN_HOSTS` = the line printed by `ssh-keyscan` in step 4
   - *Variables* tab → *New repository variable*: `DEPLOY_ENABLED` = `true`

6. Push something to `main` and watch the *Actions* tab: *Tests (Node 22)*, *Tests (Node 24)*, then *Deploy to szigzug.hu*.

7. Keep `szigzug_deploy` somewhere safe or delete it: GitHub has its copy. To revoke access, delete the line from `/home/szigzug/.ssh/authorized_keys`.

**Why not a webhook that the server `curl`s?** A webhook needs a new public endpoint on your server with its own secret checking. With Actions plus a forced-command key, nothing new listens on the internet, every deploy is gated by the tests, and the key can do exactly one thing.

## 9. Everyday commands

| Task | Command |
| --- | --- |
| App log (live) | `journalctl -u szigzug -f` |
| App status / restart | `systemctl status szigzug` / `sudo systemctl restart szigzug` |
| nginx logs | `sudo tail -f /var/log/nginx/access.log /var/log/nginx/error.log` |
| Accounts | `sudo szigzug-users list` |
| Backup now + log integrity check | `sudo systemctl start szigzug-backup.service && journalctl -u szigzug-backup -n 3` |
| Look into the database (read-only) | `sudo apt install sqlite3` then `sudo -u szigzug sqlite3 -readonly /var/lib/szigzug/szigzug.db` |

## 10. Checklist for the Opening party (18 September 2026)

Before:
- [ ] `https://szigzug.hu` works, `http://` and `www` redirect to it.
- [ ] Accounts for every organizer (the 15 names in the rulebook), the casino staff (`--casino`), the log admins and yourself. Everyone has logged in once on their own phone.
- [ ] *Szuperadmin → Osztályok*: every class from 7th to 11th grade.
- [ ] *Szuperadmin → Fiókok*: each organizer's own class (used by the own-class rule and the suspicion score).
- [ ] *Szuperadmin → Indoklások → Nyitóbuli*: check the numbers. Menetlevél 5 per stamp and 2 per person (the rulebook's example doesn't match these, so confirm with the DÖK), 1 point per minute, TB show 10 per performer, and the mini championship and casino formulas, which are **proposals**.
- [ ] *Szuperadmin → Beállítások → Kaszinó*: pick the casino method (light / visits / detailed games) and the starting chips.
- [ ] Hourly backup timer is active (step 7).

On the day:
- [ ] *Szuperadmin → Programok → Nyitóbuli → Állapot*: **Nyitva** when it starts.
- [ ] Keep an eye on *Időmérő* and *Állás*.

After:
- [ ] Set the Nyitóbuli to **Lezárva**.
- [ ] Casino: every staff member counts their chips → *Szuperadmin → Kaszinó*: enter the counts, check differences, then convert chips to points.
- [ ] *Gyanúpontszám*: look at everything at or above the threshold (60).
- [ ] *Állás*: publish the standings (label e.g. "Nyitóbuli után"). The public page shows the top 10.
- [ ] Copy a backup off the server.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| **502 Bad Gateway** | The app isn't running: `systemctl status szigzug`, `journalctl -u szigzug -n 50`. |
| Login returns to the login page | Visiting over `http://` while `COOKIE_SECURE=1`; use `https://`. |
| "A kérés nem erről az oldalról érkezett" (403) | nginx isn't passing the `Host` header (check `szigzug-proxy.conf` is included) or a browser extension strips `Origin`/`Referer`. Reload the page and try again. |
| certbot fails | DNS not pointing here yet, a wrong AAAA record, port 80 closed (`sudo ufw status`), or the HTTP config from 5a isn't active. |
| `nginx -t` complains about a duplicate `server_name` | An old config for the same site is still enabled (step 5, first command). |
| GitHub deploy step fails with "Host key verification failed" | `DEPLOY_KNOWN_HOSTS` is wrong or the server was reinstalled; redo step 8b.4. |
| Deploy script says tests failed | Nothing was changed; the site keeps running the previous version. Read the printed test output. |

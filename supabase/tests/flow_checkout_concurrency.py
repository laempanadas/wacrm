#!/usr/bin/env python3
"""Real consent RPC races in a disposable, network-isolated PostgreSQL container.

Run: python3 supabase/tests/flow_checkout_concurrency.py
Requires Docker and an available postgres:17 image (override with --image).
Never accepts a database URL, mounts host files, or publishes a database port.
Only protocol dependencies are bootstrapped, NOT the complete Supabase schema.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import select
import subprocess
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
ACCOUNT_A = "00000000-0000-0000-0000-000000000001"
ACCOUNT_B = "00000000-0000-0000-0000-000000000002"
FLOW = "10000000-0000-0000-0000-000000000001"
USER = "20000000-0000-0000-0000-000000000001"
SNAPSHOT = {
    "catalog_order_version": 1,
    "itens": [{"id": "sku", "quantity": 2, "unitPrice": 14.5}],
    "total": 29,
    "tipo_entrega": "delivery",
    "endereco": "Rua Um, 123 Centro",
}


def literal(value):
    if isinstance(value, (dict, list)):
        value = json.dumps(value)
    return "'" + str(value).replace("'", "''") + "'"


class Session:
    """A persistent psql connection; markers are not time-based race barriers."""

    def __init__(self, container, service=True):
        self.proc = subprocess.Popen(
            ["docker", "exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres",
             "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-P", "pager=off"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.stdin = self.proc.stdin
        self.stdout = self.proc.stdout
        self.buffer = b""
        if service:
            self.query("SET ROLE service_role;")
        self.pid = int(self.query("SELECT pg_backend_pid();"))

    def query(self, sql, timeout=15):
        marker = uuid.uuid4().hex.encode()
        self.stdin.write(sql.encode() + b"\n\\echo " + marker + b"\n")
        self.stdin.flush()
        deadline = time.monotonic() + timeout
        while marker + b"\n" not in self.buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.stdout], [], [], remaining)[0]:
                raise TimeoutError("psql response deadline expired: " + sql)
            chunk = os.read(self.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError("psql exited: " + self.buffer.decode())
            self.buffer += chunk
        result, self.buffer = self.buffer.split(marker + b"\n", 1)
        return result.decode().strip()

    def close(self):
        if self.proc.poll() is None:
            self.stdin.close()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.stdout.close()


class ConsentRaces(unittest.TestCase):
    container = ""
    rounds = 3

    def setUp(self):
        self.admin = Session(self.container, service=False)
        self.addCleanup(self.admin.close)
        self.first = Session(self.container)
        self.addCleanup(self.first.close)
        self.second = Session(self.container)
        self.addCleanup(self.second.close)

    def run_row(self, run):
        return json.loads(self.admin.query(
            f"SELECT row_to_json(r) FROM flow_runs r WHERE id={literal(run['id'])};"))

    def claims(self, run):
        return json.loads(self.admin.query(
            "SELECT coalesce(json_agg(c),'[]') FROM flow_checkout_claims c "
            f"WHERE run_id={literal(run['id'])};"))

    def rpc(self, name, *args):
        return f"SELECT row_to_json(r) FROM (SELECT * FROM flow_checkout_{name}({','.join(literal(a) for a in args)})) r;"

    def ready(self, account=ACCOUNT_A):
        run_id = str(uuid.uuid4())
        row = json.loads(self.admin.query(
            "INSERT INTO flow_runs(id,account_id,flow_id,user_id,current_node_key,vars) VALUES("
            f"{literal(run_id)},{literal(account)},{literal(FLOW)},{literal(USER)},"
            f"'confirmar_delivery',{literal(SNAPSHOT)}) RETURNING row_to_json(flow_runs);"))
        row = json.loads(self.first.query(self.rpc(
            "transition", account, run_id, row['consent_revision'], row['vars'],
            row['current_node_key'], {}, "summary-" + run_id)))
        return json.loads(self.first.query(self.rpc(
            "confirm", account, run_id, row['consent_revision'], row['vars'],
            "inbound-" + run_id, "text", "confirmar")))

    def authorize(self, row, account=None, revision=None):
        return self.rpc("authorize", account or row['account_id'], row['id'],
                        row['consent_revision'] if revision is None else revision, row['vars'])

    def correct(self, row):
        return self.rpc("correct", row['account_id'], row['id'], "trocar para um item")

    def finish(self, row, claim):
        return self.rpc("finish", row['account_id'], row['id'], claim,
                        {"order_id": "canonical", "total": 999}, "true")

    def blocked_race(self, winner_sql, loser_sql, rollback=False):
        self.first.query("BEGIN;")
        winner = self.first.query(winner_sql)
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.second.query, loser_sql)
            try:
                deadline = time.monotonic() + 8
                while True:
                    blocked = self.admin.query(
                        f"SELECT {self.first.pid}=ANY(pg_blocking_pids({self.second.pid}));")
                    if blocked == "t":
                        break
                    if pending.done():
                        self.fail("second RPC did not block on first connection: " + pending.result())
                    if time.monotonic() > deadline:
                        self.fail("row-lock barrier was not observed")
                    time.sleep(0.01)
            finally:
                self.first.query("ROLLBACK;" if rollback else "COMMIT;")
            loser = pending.result(timeout=15)
        return winner, loser

    def test_duplicate_authorization_exactly_one_claim(self):
        for account in (ACCOUNT_A, ACCOUNT_B):
            for _ in range(self.rounds):
                row = self.ready(account)
                winner, loser = self.blocked_race(self.authorize(row), self.authorize(row))
                self.assertTrue(json.loads(winner)['claim_id'])
                self.assertEqual(loser, '')
                self.assertEqual(len(self.claims(row)), 1)

    def test_correction_commits_before_authorization(self):
        for account in (ACCOUNT_A, ACCOUNT_B):
            for _ in range(self.rounds):
                row = self.ready(account)
                _, authorization = self.blocked_race(self.correct(row), self.authorize(row))
                self.assertEqual(authorization, '')
                self.assertEqual(self.claims(row), [])
                self.assertEqual(self.run_row(row)['vars']['pedido_confirmado'], 'false')

    def test_authorization_commits_before_correction_preserves_evidence(self):
        for account in (ACCOUNT_A, ACCOUNT_B):
            for _ in range(self.rounds):
                row = self.ready(account)
                winner, _ = self.blocked_race(self.authorize(row), self.correct(row))
                claim = json.loads(winner)['claim_id']
                result = json.loads(self.first.query(self.finish(row, claim)))
                self.assertFalse(result['owned'])
                stored = self.claims(row)[0]
                self.assertEqual(stored['state'], 'reconciliation_required')
                self.assertEqual(stored['snapshot'], row['vars'])
                self.assertEqual(stored['evidence']['order_id'], 'canonical')
                self.assertEqual(self.run_row(row)['status'], 'handed_off')

    def test_correction_commits_before_finish_does_not_restore_consent(self):
        for _ in range(self.rounds):
            row = self.ready()
            claim = json.loads(self.first.query(self.authorize(row)))['claim_id']
            corrected, finish = self.blocked_race(self.correct(row), self.finish(row, claim))
            self.assertFalse(json.loads(finish)['owned'])
            self.assertEqual(self.run_row(row)['vars'], json.loads(corrected)['vars'])
            self.assertEqual(self.claims(row)[0]['state'], 'reconciliation_required')

    def test_finish_commits_before_correction_retains_correction(self):
        for _ in range(self.rounds):
            row = self.ready()
            claim = json.loads(self.first.query(self.authorize(row)))['claim_id']
            finish, corrected = self.blocked_race(self.finish(row, claim), self.correct(row))
            self.assertTrue(json.loads(finish)['owned'])
            self.assertEqual(self.run_row(row)['vars'], json.loads(corrected)['vars'])
            self.assertEqual(self.run_row(row)['vars']['pedido_confirmado'], 'false')
            self.assertEqual(self.claims(row)[0]['state'], 'reconciliation_required')
            self.assertEqual(self.claims(row)[0]['evidence']['order_id'], 'canonical')

    def test_rollback_authorization_releases_no_partial_claim(self):
        row = self.ready()
        winner, retry = self.blocked_race(self.authorize(row), self.authorize(row), rollback=True)
        self.assertNotEqual(json.loads(winner)['claim_id'], json.loads(retry)['claim_id'])
        self.assertEqual(len(self.claims(row)), 1)
        self.assertEqual(self.claims(row)[0]['id'], json.loads(retry)['claim_id'])

    def test_connection_loss_rolls_back_authorization(self):
        row = self.ready()
        self.first.query("BEGIN;")
        abandoned = json.loads(self.first.query(self.authorize(row)))['claim_id']
        self.admin.query(f"SELECT pg_terminate_backend({self.first.pid});")
        retry = json.loads(self.second.query(self.authorize(row)))['claim_id']
        self.assertNotEqual(abandoned, retry)
        self.assertEqual(len(self.claims(row)), 1)
        self.assertEqual(self.claims(row)[0]['id'], retry)

    def test_distinct_accounts_authorize_without_sharing_run_lock(self):
        row_a = self.ready(ACCOUNT_A)
        row_b = self.ready(ACCOUNT_B)
        self.first.query("BEGIN;")
        try:
            claim_a = json.loads(self.first.query(self.authorize(row_a)))['claim_id']
            claim_b = json.loads(self.second.query(self.authorize(row_b), timeout=3))['claim_id']
            self.assertNotEqual(claim_a, claim_b)
            self.assertEqual(self.claims(row_a), [])
            self.assertEqual(len(self.claims(row_b)), 1)
        finally:
            self.first.query("COMMIT;")
        self.assertEqual(len(self.claims(row_a)), 1)

    def test_stale_revision_old_button_and_foreign_account(self):
        row = self.ready()
        self.assertEqual(self.first.query(self.authorize(row, revision=row['consent_revision'] - 1)), '')
        self.assertEqual(self.first.query(self.authorize(row, account=ACCOUNT_B)), '')
        self.assertEqual(self.second.query(self.rpc("correct", ACCOUNT_B, row['id'], 'foreign')), '')
        newer = json.loads(self.first.query(self.rpc(
            "transition", ACCOUNT_A, row['id'], row['consent_revision'], row['vars'],
            row['current_node_key'], {}, 'new-summary')))
        self.assertEqual(self.second.query(self.rpc(
            'confirm', ACCOUNT_A, row['id'], newer['consent_revision'], newer['vars'],
            'old-click-' + row['id'], 'interactive_reply', 'confirmar_pedido', 'summary-' + row['id'])), '')
        self.assertEqual(self.first.query(self.authorize(newer)), '')
        self.assertEqual(self.claims(row), [])
        confirmed = json.loads(self.first.query(self.rpc(
            'confirm', ACCOUNT_A, row['id'], newer['consent_revision'], newer['vars'],
            'fresh-click-' + row['id'], 'interactive_reply', 'confirmar_pedido', 'new-summary')))
        claim = json.loads(self.first.query(self.authorize(confirmed)))['claim_id']
        self.assertEqual(self.second.query(self.rpc('finish', ACCOUNT_B, row['id'], claim, {}, 'true')), '')
        self.assertEqual(self.claims(row)[0]['state'], 'started')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', default='postgres:17')
    parser.add_argument('--rounds', type=int, default=3)
    args = parser.parse_args()
    if args.rounds < 1:
        parser.error('--rounds must be positive')
    name = 'wacrm-consent-test-' + uuid.uuid4().hex[:12]
    started = False
    try:
        subprocess.run(['docker', 'run', '--detach', '--rm', '--name', name,
                        '--network', 'none', '--tmpfs', '/var/lib/postgresql/data',
                        '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', args.image], check=True,
                       stdout=subprocess.DEVNULL)
        started = True
        deadline = time.monotonic() + 40
        while subprocess.run(['docker', 'exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            if time.monotonic() > deadline:
                raise TimeoutError('disposable PostgreSQL failed to start')
            time.sleep(0.1)
        inspected = json.loads(subprocess.check_output(['docker', 'inspect', name]))[0]
        assert inspected['HostConfig']['NetworkMode'] == 'none'
        assert not inspected['HostConfig'].get('PortBindings')
        assert not inspected['HostConfig'].get('Binds')
        admin = Session(name, service=False)
        try:
            admin.query((ROOT / 'supabase/tests/flow_checkout_concurrency_fixture.sql').read_text())
            migration = (ROOT / 'supabase/migrations/010_flows.sql').read_text()
            for table in ('flow_nodes', 'flow_runs'):
                start = migration.index('CREATE TABLE IF NOT EXISTS ' + table + ' (')
                end = migration.index('\n);', start) + len('\n);')
                admin.query(migration[start:end])
            admin.query('ALTER TABLE flow_runs ADD COLUMN account_id uuid NOT NULL REFERENCES accounts(id);')
            admin.query((ROOT / 'supabase/migrations/038_flow_checkout_consent.sql').read_text())
            admin.query(f"INSERT INTO accounts VALUES ({literal(ACCOUNT_A)}),({literal(ACCOUNT_B)});"
                        f"INSERT INTO auth.users VALUES ({literal(USER)});"
                        f"INSERT INTO flows VALUES ({literal(FLOW)});")
            config = {'buttons': [{'reply_id': 'confirmar_pedido'}],
                      'text': '{{vars.itens_lista}} {{vars.total_formatado}} {{vars.observacoes}} {{vars.endereco}}'}
            admin.query("INSERT INTO flow_nodes(flow_id,node_key,node_type,config) VALUES("
                        f"{literal(FLOW)},'confirmar_delivery','send_buttons',{literal(config)});")
            # Existing sequential protocol/privilege assertions run on the same real definitions.
            admin.query((ROOT / 'supabase/tests/flow_checkout_consent.sql').read_text())
            print('PASS: existing sequential protocol and privilege assertions', flush=True)
        finally:
            admin.close()
        ConsentRaces.container = name
        ConsentRaces.rounds = args.rounds
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ConsentRaces))
        return 0 if result.wasSuccessful() else 1
    finally:
        if started:
            subprocess.run(['docker', 'rm', '--force', name], check=True, stdout=subprocess.DEVNULL)
            print('Disposable PostgreSQL removed (no shared database accessed).', flush=True)


if __name__ == '__main__':
    raise SystemExit(main())

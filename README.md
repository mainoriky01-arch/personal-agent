# Personal Agent — Monorepo

Behavioural agent (spec v1.0). Monorepo pnpm, struttura da spec §22.5.

## Cosa c'è ora

```
personal-agent/
├── packages/
│   ├── shared-types/         ✅ modello dominio (spec §8, §24)
│   ├── rule-engine/          ✅ motore deterministico (§13-15) — 23 test
│   ├── rule-drafting/        ✅ testo → bozza validata (§12, §27) — 19 test
│   ├── intervention-writer/  ✅ messaggi + Safety Layer (§19, §27.5) — 16 test
│   └── intervention-service/ ✅ orchestratore end-to-end (§23.5) — 9 test
└── apps/
    └── backend/              ✅ schema SQL + repos + API + AI orchestration
                                 (§23-25) — 11 test

78 test verdi · typecheck pulito su 6 package
```

## Il cuore: `@pa/rule-engine`

La decisione di intervento è una **funzione pura** — `decide(rule, session, ctx)`:
niente I/O, niente clock globale (il tempo è passato come input), **niente
chiamate LLM nel percorso caldo**. È esattamente la separazione che la spec impone
(§42.4-5): l'AI *propone* le regole e scrive il testo dei messaggi, ma
l'**esecuzione** vive qui ed è deterministica e testabile.

`decide()` restituisce una `Decision` con:
- `kind` — none / prewarn / intervene / escalate / complete / skip / emergency / terminate
- `nextState` — prossimo stato della macchina a stati (§15)
- `level` + `action` — livello di escalation e azione concreta
- `reason` — motivo leggibile (§42.20 "ogni funzione deve spiegare perché è intervenuta")

### Cosa è già coperto dai test (§39.1)

- Finestra normale **e** a cavallo della mezzanotte
- Giorni attivi / eccezioni (§8.5)
- Cooldown anti-spam (§14.5) — blocca dentro, permette dopo
- Cap per sessione + budget giornaliero (§8.9, §14.5) — niente notifiche infinite
- Escalation lungo la scala con clamp in cima
- Quiet hours che trattengono i messaggi (§14.5)
- Uscita di emergenza che scavalca tutto (§7.6)
- Ogni decisione porta un `reason` non vuoto (§42.20)

## Comandi

```bash
pnpm install
pnpm --filter @pa/rule-engine test    # 23 test → verdi
pnpm -r typecheck                     # tutti i package
pnpm -r build
```

Verificato su questa macchina: **23/23 test passano, typecheck pulito su 3/3 package**
(Node 22, pnpm 10.30, vitest 2.1).

## Principio architetturale da non rompere

> L'AI non esegue mai un blocco. Produce una bozza di regola (che l'utente
> conferma) e il testo dei messaggi. Il `rule-engine` decide *quando* e *cosa*.
> Le estensioni native (vedi `personal-agent-phase0/`) applicano lo shield.

Tre strati, tre responsabilità separate. Questo è ciò che rende il prodotto
verificabile invece che "magico e imprevedibile".

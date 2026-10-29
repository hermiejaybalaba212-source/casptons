"""DRY RUN ONLY - trains on the cleaned TES dataset locally, prints results.
Nothing here touches the web system, Storage, or the app's ml/ code.
"""
from __future__ import annotations

import csv
from collections import Counter
from pathlib import Path

import numpy as np
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.metrics import (accuracy_score, f1_score, mean_absolute_error,
                             precision_score, r2_score, recall_score)

SRC = Path(r"C:\Users\kolin\Downloads\St. Peter's College TES Application Form 1ST SE. AY2026-2027_ML_READY.csv")

# Statutory priority weights (basis: PH laws) - the "need" label when no income exists
W = {"pwd_flag": 15, "ip_flag": 15, "solo_parent": 10, "is_4ps": 10, "first_gen": 5}
HIGH_NEED = 60  # label threshold


def load():
    rows = list(csv.DictReader(SRC.open(encoding="utf-8-sig")))
    programs = sorted({r["program"] for r in rows if r["program"]})
    pcode = {p: i for i, p in enumerate(programs)}
    X, y, meta = [], [], []
    for i, r in enumerate(rows, 1):
        pwd = int(r["pwd_flag"] or 0)
        ip = int(r["ip_flag"] or 0)
        solo = int(r["solo_parent"] or 0)
        fg = int(r["first_gen"] or 0)
        ps4 = int(r["is_4ps"] or 0)
        age = int(r["age"]) if r["age"] else 20
        yr = int(r["year_level"]) if r["year_level"] else 0
        sex = {"Male": 0, "Female": 1}.get(r["sex"], 2)
        prog = pcode.get(r["program"], -1)
        score = min(100.0, 50.0 + W["pwd_flag"] * pwd + W["ip_flag"] * ip
                    + W["solo_parent"] * solo + W["is_4ps"] * ps4 + W["first_gen"] * fg)
        X.append([pwd, ip, solo, ps4, fg, sex, yr, age, prog])
        y.append(score)
        meta.append({"row": i, "program": r["program"], "year": yr, "age": age,
                     "sex": r["sex"], "pwd": pwd, "ip": ip, "solo": solo,
                     "ps4": ps4, "fg": fg, "score": score,
                     "ipg": r["ip_group"], "pwdc": r["disability_category"]})
    return np.asarray(X, float), np.asarray(y, float), meta, programs


FEATURES = ["pwd_flag", "ip_flag", "solo_parent", "is_4ps", "first_gen",
            "sex", "year_level", "age", "program"]


def main():
    X, y, meta, programs = load()
    n = len(y)
    print("=" * 74)
    print("DRY RUN - training preview on your cleaned dataset (SYSTEM UNTOUCHED)")
    print("=" * 74)
    print(f"rows                : {n}")
    print(f"features            : {len(FEATURES)} -> {', '.join(FEATURES)}")
    print(f"programs (encoded)  : {len(programs)}")
    print(f"flag counts         : PWD={int(X[:,0].sum())}  IP={int(X[:,1].sum())}  "
          f"solo-parent={int(X[:,2].sum())}  4Ps={int(X[:,3].sum())}  first-gen={int(X[:,4].sum())}")
    print(f"priority score      : min {y.min():.0f} | mean {y.mean():.1f} | max {y.max():.0f} | "
          f"high-need(>=60): {int((y >= HIGH_NEED).sum())} rows")
    buckets = Counter()
    for v in y:
        buckets["75-100" if v >= 75 else "60-74" if v >= 60 else "50-59" if v >= 50 else "<50"] += 1
    print(f"score distribution  : " + " | ".join(f"{k}: {buckets[k]}" for k in ("75-100", "60-74", "50-59", "<50")))

    # deterministic split
    rng = np.random.RandomState(42)
    idx = rng.permutation(n)
    cut = int(0.8 * n)
    tr, te = idx[:cut], idx[cut:]

    # --- regressor: predict the priority score
    reg = RandomForestRegressor(n_estimators=100, random_state=42, n_jobs=-1)
    reg.fit(X[tr], y[tr])
    pred = reg.predict(X[te])
    print("-" * 74)
    print("REGRESSOR (predict priority score)  80/20 split")
    print(f"  R^2   : {r2_score(y[te], pred):.4f}")
    print(f"  MAE   : {mean_absolute_error(y[te], pred):.2f} points")

    # --- classifier: high-need yes/no
    clf = RandomForestClassifier(n_estimators=100, random_state=42, n_jobs=-1)
    clf.fit(X[tr], (y[tr] >= HIGH_NEED))
    cpred = clf.predict(X[te])
    print("CLASSIFIER (high-need >= 60 : yes/no)")
    print(f"  accuracy    : {accuracy_score(y[te] >= HIGH_NEED, cpred):.4f}")
    print(f"  precision   : {precision_score(y[te] >= HIGH_NEED, cpred, zero_division=0):.4f}")
    print(f"  recall      : {recall_score(y[te] >= HIGH_NEED, cpred, zero_division=0):.4f}")
    print(f"  f1          : {f1_score(y[te] >= HIGH_NEED, cpred, zero_division=0):.4f}")

    # --- feature importance
    imp = sorted(zip(FEATURES, reg.feature_importances_), key=lambda x: -x[1])
    print("-" * 74)
    print("FEATURE IMPORTANCE (asa magbasi ang ranking):")
    for f, v in imp:
        bar = "#" * int(v * 60)
        print(f"  {f:12s} {v*100:5.1f}%  {bar}")

    # --- sample ranking (top 15 highest need)
    ranked = sorted(meta, key=lambda m: -m["score"])
    print("-" * 74)
    print("SAMPLE RANKING - top 15 most in need (anonymous rows):")
    print(f"  {'RANK':4s} {'ROW':4s} {'SCORE':6s} {'YR':3s} {'AGE':3s} {'SEX':6s} "
          f"{'PWD':3s} {'IP':3s} {'SOLO':4s} {'4PS':3s} {'1GEN':4s}  PROGRAM")
    for k, m in enumerate(ranked[:15], 1):
        print(f"  {k:<4d} {m['row']:<4d} {m['score']:<6.0f} {m['year']:<3d} {m['age']:<3d} "
              f"{m['sex'][:5]:6s} {m['pwd']:3d} {m['ip']:3d} {m['solo']:4d} {m['ps4']:3d} "
              f"{m['fg']:4d}  {m['program'][:34]}")

    # --- fairness check: are priority flags surfacing on top?
    top20 = ranked[:20]
    print("-" * 74)
    print("FAIRNESS CHECK (top 20 vs whole dataset):")
    print(f"  PWD in top 20 : {sum(m['pwd'] for m in top20)} / 20   "
          f"(dataset rate {int(X[:,0].sum())}/{n} = {100*X[:,0].sum()/n:.1f}%)")
    print(f"  IP  in top 20 : {sum(m['ip'] for m in top20)} / 20   "
          f"(dataset rate {int(X[:,1].sum())}/{n} = {100*X[:,1].sum()/n:.1f}%)")
    print(f"  4Ps in top 20 : {sum(m['ps4'] for m in top20)} / 20   "
          f"(dataset rate {int(X[:,3].sum())}/{n} = {100*X[:,3].sum()/n:.1f}%)")
    print("=" * 74)
    print("NOTE: score = neutral 50 + statutory priority weights (no income in the")
    print("      dataset). If an applicant HAS ITR/income, the real system ranks that")
    print("      applicant with the income signal on top of these flags.")
    print("STATUS: system untouched - this is a local preview only.")
    print("=" * 74)


if __name__ == "__main__":
    main()

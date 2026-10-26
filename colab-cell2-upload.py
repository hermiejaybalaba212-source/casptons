# --- OPTIONAL CELL 2: train on YOUR OWN historical data ----------------------
# Run this AFTER Cell 1. Paste it as a second cell in Colab.
# It asks you to choose a file: training_data.csv or .xlsx, or ANY CSV shaped
# like your past scholarship applications. Income column optional, aliases
# accepted, ITR column optional — rows without income keep a neutral need
# score and training/ranking keeps working 100%.

import io
from google.colab import files as colab_files

uploaded = colab_files.upload()          # choose your file here
name = next(iter(uploaded))
payload = uploaded[name]

text = payload.decode("utf-8", errors="replace")
warns = []
YOURS = csv_rows_from_csv_text(text, warns)

print(f"\nYour historical file: {name}")
print(f"Rows usable for training: {len(YOURS)}")
for w in warns:
    print("  ·", w)

if YOURS:
    res2 = train(historical=YOURS)
    print(f"\n=== RETRAINED WITH YOUR DATA ===")
    print(f"rows={res2['n_rows']} (synthetic {res2['n_synthetic']} + yours {res2['n_csv']}) | "
          f"accuracy={res2['accuracy']} f1={res2['f1']} roc_auc={res2['roc_auc']} r2={res2['r2']}")
    print("Feature importance:", json.dumps(res2["feature_importance"]))
    retrained = rank_applicants([build_row(a, o) for a, o in demo], res2["model"])
    print("\nDemo ranking with your model:")
    for r in retrained:
        print(f"  #{r['rank']} {r['student']:<16} used={str(r['income_used']):>10} "
              f"trust={r['itr_trust']:<9} priority={r['priority_score']:>6.2f}  {r['prediction']} ({r['probability']})")
    joblib.dump(dict(res2["model"]), model_path, compress=3)
    print(f"\nUpdated model -> {model_path}")
    colab_files.download(model_path)
else:
    print("No rows parsed — widen the columns? (any income-alias header works; see Cell 1 aliases)")

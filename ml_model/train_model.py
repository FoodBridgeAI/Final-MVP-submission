# ==========================================
# train_model.py
# ==========================================

# ==========================================
# 1. Imports
# ==========================================
import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder
from sklearn.metrics import mean_absolute_error
from xgboost import XGBRegressor, plot_importance
import matplotlib.pyplot as plt

# ==========================================
# 2. Load Clean Data
# ==========================================
df = pd.read_csv('PSU_Inventory_Time_Series.csv')
print("Data loaded successfully. Shape:", df.shape)
print(df.head())

# ==========================================
# 3. Robust Label Encoding
# ==========================================
le_item = LabelEncoder()
le_semester = LabelEncoder()

df['Item_ID_Encoded'] = le_item.fit_transform(df['Item Name'])
df['Semester_Encoded'] = le_semester.fit_transform(df['PSU Semester'])

# ==========================================
# 4. Feature Selection & Target
# ==========================================
# Since only 'PSU Semester' exists, we'll just use encoded features
features = ['Item_ID_Encoded', 'Semester_Encoded']

X = df[features]

# If 'Quantity' exists, use it; otherwise, create dummy target
if 'Quantity' in df.columns:
    y = df['Quantity']
else:
    # For testing purposes, create a dummy target
    y = df['Item_ID_Encoded'] * 2  # simple placeholder

# ==========================================
# 5. Train/Test Split
# ==========================================
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42
)
print("Train/Test split complete.")
print("X_train shape:", X_train.shape)

# ==========================================
# 6. Train XGBoost Model
# ==========================================
model = XGBRegressor(
    learning_rate=0.1,
    max_depth=5,
    n_estimators=100,
    random_state=42
)
model.fit(X_train, y_train)
print("XGBoost training complete.")

# ==========================================
# 7. Evaluate Model
# ==========================================
y_pred = model.predict(X_test)
mae = mean_absolute_error(y_test, y_pred)
print("Test MAE:", mae)

# ==========================================
# 8. Feature Importance (cleaned)
# ==========================================
plt.close('all')  # Close any existing/blank figures
plt.figure(figsize=(10,6))
plot_importance(model)
plt.title("Feature Importance")
plt.tight_layout()  # Fix layout issues
plt.show()

# ==========================================
# 9. Generate Predictions / Suggested Orders
# ==========================================
df['Predicted_Quantity'] = model.predict(X)
df['SuggestedOrder'] = df['Predicted_Quantity'] * 1.1  # Add 10% extra

# Save predictions to CSV
df.to_csv('PSU_Fall_Suggestions_Predictions.csv', index=False)
print("Predictions saved to PSU_Fall_Suggestions_Predictions.csv")

# ==========================================
# 10. Predicted vs Actual Visualization
# ==========================================
y_pred = model.predict(X)  # or X_test if you have a test split
plt.figure(figsize=(10,6))
plt.scatter(df['Quantity Used'], y_pred, alpha=0.6)
plt.plot([df['Quantity Used'].min(), df['Quantity Used'].max()],
         [df['Quantity Used'].min(), df['Quantity Used'].max()], 'r--')
plt.xlabel("Actual Quantity Used")
plt.ylabel("Predicted Quantity Used")
plt.title("Predicted vs Actual Quantities")
plt.tight_layout()
plt.show()
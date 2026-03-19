import pandas as pd
import numpy as np
import xgboost as xgb
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder
import os

# 1. Setup Paths
folder_path = os.path.dirname(os.path.abspath(__file__))
history_file = os.path.join(folder_path, 'PSU_Inventory_Time_Series.csv')
trends_file = os.path.join(folder_path, 'PSU_Seasonal_Trends.csv')

# 2. Load and Verify Files
if not os.path.exists(history_file):
    print(f"Error: Could not find {history_file}. Please run the cleaning script first.")
    exit()

df_history = pd.read_csv(history_file)
df_trends = pd.read_csv(trends_file)

# Filter for Food only
food_df = df_history[df_history['Item Category'] == 'Food'].copy()

if food_df.empty:
    print("Error: No items found in the 'Food' category. Check your supply_keywords filter.")
    exit()

# ==========================================
# 3. Robust Label Encoding
# ==========================================
le_item = LabelEncoder()
le_semester = LabelEncoder()

# SAFETY: We define all possible semesters so the encoder always knows them
all_possible_semesters = [
    'Fall Semester', 
    'Spring Semester', 
    'Summer Break', 
    'Winter/Spring Transition'
]

# Fit the encoder on the full list of names, not just what's in the data right now
le_semester.fit(all_possible_semesters)
le_item.fit(food_df['Item Name'].unique())

# Transform the data
food_df['item_id'] = le_item.transform(food_df['Item Name'])
food_df['semester_id'] = le_semester.transform(food_df['PSU Semester'])

# ==========================================
# 4. Training
# ==========================================
X = food_df[['item_id', 'semester_id']]
y = food_df['Quantity Used']

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

print("Training the FoodBridge Decision Tree...")
model = xgb.XGBRegressor(objective='reg:squarederror', n_estimators=100)
model.fit(X_train, y_train)

# ==========================================
# 5. Recommendation Logic
# ==========================================
def get_order_suggestion(semester_name):
    # Ensure the requested semester is valid
    if semester_name not in all_possible_semesters:
        print(f"Error: {semester_name} is not a valid PSU Semester name.")
        return None

    # Get all unique food items
    unique_items = food_df[['Item Name']].drop_duplicates()
    unique_items['item_id'] = le_item.transform(unique_items['Item Name'])
    
    # Create prediction input
    sem_id = le_semester.transform([semester_name])[0]
    prediction_input = unique_items.copy()
    prediction_input['semester_id'] = sem_id
    
    # Predict
    preds = model.predict(prediction_input[['item_id', 'semester_id']])
    # Ensure no negative predictions (ML can sometimes do this)
    prediction_input['Predicted_Demand'] = np.maximum(0, preds)
    
    # Merge with Seasonal Trends (File 2)
    comparison = pd.merge(
        prediction_input, 
        df_trends[df_trends['PSU Semester'] == semester_name],
        on='Item Name',
        how='left'
    )
    
    return comparison[['Item Name', 'PSU Semester', 'Predicted_Demand', 'Quantity Used']].sort_values(by='Predicted_Demand', ascending=False)

# --- Run Test ---
try:
    fall_recommendations = get_order_suggestion('Fall Semester')
    print("\n--- Top 5 Recommended Food Items for Fall Semester ---")
    print(fall_recommendations.head(5))
    
    # Save results
    output_path = os.path.join(folder_path, 'PSU_Fall_Order_Suggestions.csv')
    fall_recommendations.to_csv(output_path, index=False)
    print(f"\nSuccess! Order suggestions saved to: {output_path}")

except Exception as e:
    print(f"An error occurred during prediction: {e}")
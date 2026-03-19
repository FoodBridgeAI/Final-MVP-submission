import pandas as pd
import numpy as np
import xgboost as xgb
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder
import os

# ==========================================
# 1. SETUP PATHS & LOAD RAW DATA
# ==========================================
folder_path = os.path.dirname(os.path.abspath(__file__))
raw_input_file = os.path.join(folder_path, 'Data for Analysis - Inventory UTF.csv')

if not os.path.exists(raw_input_file):
    print(f"CRITICAL ERROR: Could not find '{raw_input_file}'")
    print("Please make sure your raw inventory CSV is in this folder.")
    exit()

df = pd.read_csv(raw_input_file)

# Standardize column names (removes the \n characters)
df.columns = [" ".join(col.split()) for col in df.columns]

# This removes the accounting outliers that skew your AI's predictions
df = df[~df['Item Name'].str.contains('ADJUSTMENT|FREIGHT|MISC', case=False, na=False)]

# ==========================================
# 2. CLEANING & CATEGORIZING (Creating the 2 CSVs)
# ==========================================
print("Cleaning data and creating PSU-specific datasets...")

# Tag items as Food vs Supply (Added more keywords for PSU Dining)
supply_keywords = ['APRON', 'WRAP', 'FOIL', 'PAPER', 'BAG', 'TOWEL', 'CLOTH', 
                   'GLOVE', 'CLEANER', 'SOAP', 'FORK', 'SPOON', 'KNIFE', 'PLATE', 'CUP']

df['Item Category'] = df['Item Name'].apply(
    lambda x: 'Supply' if any(k in str(x).upper() for k in supply_keywords) else 'Food'
)


# Identify the usage months
usage_cols = [col for col in df.columns if '/' in col and '-' in col]

# Transform to Time Series (Long Format)
df_long = pd.melt(df, id_vars=['Item Name', 'Item Category', 'Pack'], 
                  value_vars=usage_cols, var_name='Period', value_name='Quantity Used')

# Define PSU Semesters accurately
def get_psu_semester(period):
    # period looks like "09/01/25-09/30/25"
    month = period[:2] # This grabs ONLY the "09"
    
    if month in ['06', '07', '08']:
        return 'Summer Semester'
    elif month in ['09', '10', '11']:
        return 'Fall Semester'
    elif month in ['12', '01']:
        return 'Winter Break'
    else:
        return 'Spring Semester'

df_long['PSU Semester'] = df_long['Period'].apply(get_psu_semester)

# Save File 1
df_long.to_csv(os.path.join(folder_path, 'PSU_Inventory_Time_Series.csv'), index=False)

# Create and Save File 2 (Seasonal Trends)
df_trends = df_long[df_long['Item Category'] == 'Food'].groupby(
    ['Item Name', 'PSU Semester'])['Quantity Used'].mean().reset_index()
df_trends.to_csv(os.path.join(folder_path, 'PSU_Seasonal_Trends.csv'), index=False)

# ==========================================
# 3. TRAINING THE MODEL
# ==========================================
print("Training the Decision Tree...")

food_df = df_long[df_long['Item Category'] == 'Food'].copy()

# Encoders
le_item = LabelEncoder()
le_semester = LabelEncoder()

# Fit semester encoder on ALL possible labels to prevent the 'Unseen Labels' error
all_semesters = ['Fall Semester', 'Spring Semester', 'Summer Semester', 'Winter Break']
le_semester.fit(all_semesters)
le_item.fit(food_df['Item Name'].unique())

food_df['item_id'] = le_item.transform(food_df['Item Name'])
food_df['semester_id'] = le_semester.transform(food_df['PSU Semester'])

# ML Model
X = food_df[['item_id', 'semester_id']]
y = food_df['Quantity Used']
model = xgb.XGBRegressor(objective='reg:squarederror', n_estimators=100)
model.fit(X, y)

# ==========================================
# 4. GENERATING RECOMMENDATIONS
# ==========================================
def suggest_for_psu(target_semester):
    print(f"\nGenerating suggestions for: {target_semester}")
    
    unique_items = food_df[['Item Name']].drop_duplicates()
    unique_items['item_id'] = le_item.transform(unique_items['Item Name'])
    unique_items['semester_id'] = le_semester.transform([target_semester] * len(unique_items))
    
    # Predict
    preds = model.predict(unique_items[['item_id', 'semester_id']])
    unique_items['Predicted_Demand'] = np.maximum(0, preds)
    
    # Compare with History (Merge with File 2)
    final = pd.merge(unique_items, df_trends[df_trends['PSU Semester'] == target_semester], 
                     on='Item Name', how='left')
    
    return final[['Item Name', 'Predicted_Demand', 'Quantity Used']].sort_values(by='Predicted_Demand', ascending=False)

# --- EXECUTION ---
try:
    results1 = suggest_for_psu('Fall Semester')    
    print(results1.head(10))
    results2 = suggest_for_psu('Spring Semester')
    print(results2.head(10))
    results1.to_csv(os.path.join(folder_path, 'PSU_Fall_Suggestions.csv'), index=False)
    results1.to_csv(os.path.join(folder_path, 'PSU_Spring_Suggestions.csv'), index=False)
    print("\nSUCCESS: All files synced and Fall suggestions exported.")
except Exception as e:
    print(f"Error during execution: {e}")
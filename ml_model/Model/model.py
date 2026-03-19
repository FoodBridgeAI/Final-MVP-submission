import pandas as pd
import numpy as np
import os
from datetime import datetime

# ==========================================
# 1. SETUP PATHS & DATE
# ==========================================
script_dir = os.path.dirname(os.path.abspath(__file__))
raw_input_file = os.path.join(script_dir, 'Inventory_Master_Analysis_final.csv')
output_dir = os.path.join(script_dir, 'Model output')

# Detect current month for seasonality logic
now = datetime.now()
current_month = now.month
month_name = now.strftime("%B")

if not os.path.exists(raw_input_file):
    print(f"CRITICAL ERROR: Could not find '{raw_input_file}'")
    exit()

print(f"Generating {month_name} Suggestions...")
df = pd.read_csv(raw_input_file)

# --- NOISE FILTERING ---
# Removes freight, one-off items (<3 months history), and inactive products
df = df[~df['Item Name'].str.contains('ADJUSTMENT|FREIGHT|MISC', case=False, na=False)]
df = df[df['Demand_Pattern'] != 'Inactive']
df = df[df['Total Usage'] > 0]
df = df[df['Active_Months'] >= 3] 

# ==========================================
# 2. MONTHLY PEAK DETECTION LOGIC
# ==========================================
def is_in_peak(peak_str, target_month):
    try:
        if pd.isna(peak_str) or peak_str == "No Usage": return False
        parts = peak_str.split(' to ')
        start_month = int(parts[0].split('/')[0])
        end_month = int(parts[1].split('/')[0])
        if start_month <= end_month:
            return start_month <= target_month <= end_month
        else: # Handle wrap-around seasons (Nov-Feb)
            return target_month >= start_month or target_month <= end_month
    except:
        return False

# ==========================================
# 3. CALCULATE SMART DEMAND
# ==========================================
# Baseline Average
df['Avg_Monthly_Usage'] = np.ceil(df['Total Usage'] / df['Active_Months']).astype(int)

# Apply Growth Rate and Seasonality
df['Trend_Adjusted'] = df['Avg_Monthly_Usage'] * (1 + df['Growth_Rate'])
df['Currently_In_Peak'] = df['Peak_Season'].apply(lambda x: is_in_peak(x, current_month))

df['Monthly_Demand'] = np.where(
    df['Currently_In_Peak'],
    df['Trend_Adjusted'] * df['Seasonality_Index'],
    df['Trend_Adjusted']
)

# Apply 5% Safety Buffer
df['Gross_Requirement'] = np.ceil(df['Monthly_Demand'] * 1.05).astype(int)

# Loss Prevention: Cap volatile items (CV > 1.0) at 10% over average
df['Gross_Requirement'] = np.where(
    (df['Volatility_CV'] > 1.0) & (df['Gross_Requirement'] > df['Avg_Monthly_Usage'] * 1.1),
    np.ceil(df['Avg_Monthly_Usage'] * 1.1).astype(int),
    df['Gross_Requirement']
)

# ==========================================
# 4. POLISHING & FINAL OUTPUT GENERATION
# ==========================================
# Net Order = Requirement minus what you have in the room
df['Order_Qty'] = np.maximum(0, df['Gross_Requirement'] - df['On Hand Count'])

# Filter out items that don't need a purchase
final_report = df[df['Order_Qty'] > 0].copy()

# Visual Cleanup for professional report
final_report['Product'] = final_report['Item Name'].str.title()
final_report['Priority'] = final_report['Volume_Class'].str[0]

final_report = final_report[[
    'Product', 'Pack', 'Order_Qty', 'Avg_Monthly_Usage', 'On Hand Count', 'Priority', 'Currently_In_Peak'
]]

final_report.columns = [
    'Product', 'Unit', 'Order Qty', 'Avg Monthly Usage', 'Stock on Hand', 'Priority', 'Seasonal Peak'
]

# Sort by Importance (A items first)
final_report = final_report.sort_values(['Priority', 'Order Qty'], ascending=[True, False])

# ==========================================
# 5. SAVE SINGLE OUTPUT
# ==========================================
try:
    os.makedirs(output_dir, exist_ok=True)
    filename = 'Monthly_Buy_Suggestions.csv'
    output_path = os.path.join(output_dir, filename)
    
    final_report.to_csv(output_path, index=False)
    
    print("\n" + "="*50)
    print(f"SUCCESS: {filename} generated.")
    print(f"Total Unique Items to Buy: {len(final_report)}")
    print("="*50)

except Exception as e:
    print(f"Error saving list: {e}")
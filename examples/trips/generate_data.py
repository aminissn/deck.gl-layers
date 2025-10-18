"""
Convert SUMO FCD parquet output data to trips.feather format compatible with deck.gl TripsLayer
This script reads vehicle trajectory data and converts it to the same format as generate_data.py
"""
import pandas as pd
import numpy as np
import pyarrow as pa
import pyarrow.feather as feather
import gzip
import io
import os

# Configuration
INPUT_FILE = "public/fcd_out.parquet"
OUTPUT_FILE = "public/trips.feather.gz"

# Optional: Sample only a subset of vehicles for better performance
# Set to None to process all vehicles, or set a number like 1000 to sample
SAMPLE_VEHICLES = 100  # Change to 1000, 5000, etc. to limit vehicle count

print("Reading FCD parquet file...")
df = pd.read_parquet(INPUT_FILE)
df = df.loc[(df['timestep_time']< 7.25*3600) & (df['timestep_time']> 7*3600)]

print(f"Total vehicles in source: {df['vehicle_id'].nunique()}")
print(f"Total positions: {len(df)}")

# Sort by vehicle and time to ensure correct order
df = df.sort_values(['vehicle_id', 'timestep_time'])

# Optional sampling
if SAMPLE_VEHICLES is not None:
    unique_vehicles = df['vehicle_id'].unique()
    sampled_vehicles = np.random.choice(
        unique_vehicles, 
        size=min(SAMPLE_VEHICLES, len(unique_vehicles)), 
        replace=False
    )
    df = df[df['vehicle_id'].isin(sampled_vehicles)]
    print(f"Sampled {len(sampled_vehicles)} vehicles")

# Group by vehicle_id to create trips (one trip per vehicle)
grouped = df.groupby('vehicle_id')

# Calculate dimensions
geoms_num = len(grouped)
coord_num = len(df)

print(f"Processing {geoms_num} vehicles with {coord_num} total positions...")

# Initialize arrays
offsets = np.zeros(geoms_num + 1, dtype=np.int32)
coords = np.zeros((coord_num, 2), dtype=np.float32)
timestamps = np.zeros(coord_num, dtype=np.float32)
speeds = np.zeros(coord_num, dtype=np.float32)
edges = []  # Store edge IDs as strings
positions = np.zeros(coord_num, dtype=np.float32)  # Position on edge
relative_speeds = np.zeros(coord_num, dtype=np.float32)  # Relative speed
angles = np.zeros(coord_num, dtype=np.float32)  # Vehicle orientation angle

# Store vehicle attributes (one per vehicle/trip)
vehicle_ids = []

# Process each vehicle's trajectory
current_offset = 0
for i, (vehicle_id, group) in enumerate(grouped):
    num_positions = len(group)
    
    # Store coordinates (longitude, latitude)
    coords[current_offset:current_offset + num_positions, 0] = group['vehicle_x'].values
    coords[current_offset:current_offset + num_positions, 1] = group['vehicle_y'].values
    
    # Store timestamps
    timestamps[current_offset:current_offset + num_positions] = group['timestep_time'].values
    
    # Store instantaneous speeds
    if 'vehicle_speed' in group.columns:
        speeds[current_offset:current_offset + num_positions] = group['vehicle_speed'].values
    else:
        speeds[current_offset:current_offset + num_positions] = 0.0
    
    # Store edge IDs
    if 'vehicle_edge' in group.columns:
        for edge_id in group['vehicle_edge'].values:
            edges.append(str(edge_id))
    else:
        for _ in range(num_positions):
            edges.append("")
    
    # Store positions on edge
    if 'vehicle_pos' in group.columns:
        positions[current_offset:current_offset + num_positions] = group['vehicle_pos'].values
    else:
        positions[current_offset:current_offset + num_positions] = 0.0
    
    # Store relative speeds
    if 'vehicle_speedRelative' in group.columns:
        relative_speeds[current_offset:current_offset + num_positions] = group['vehicle_speedRelative'].values 
    else:
        # Default to 0.5 (mid-range) if column not found
        relative_speeds[current_offset:current_offset + num_positions] = 1.0
    
    # Store vehicle angles (orientation)
    # SUMO angle is in degrees, 0 = North, 90 = East, 180 = South, 270 = West
    if 'vehicle_angle' in group.columns:
        angles[current_offset:current_offset + num_positions] = group['vehicle_angle'].values
    else:
        # Default to 0 (facing north) if column not found
        angles[current_offset:current_offset + num_positions] = 0.0
    
    # Store vehicle attributes
    vehicle_ids.append(str(vehicle_id))
    
    # Update offset
    current_offset += num_positions
    offsets[i + 1] = current_offset
    
    # Progress indicator
    if (i + 1) % 1000 == 0:
        print(f"Processed {i + 1}/{geoms_num} vehicles...")

# Keep original timestamps (seconds since midnight) for display
# Don't normalize to 0 - we want to show actual time of day
min_timestamp = timestamps.min()
max_timestamp = timestamps.max()

print(f"\nTimestamp range: {min_timestamp} ({min_timestamp/3600:.2f} hours) to {max_timestamp} ({max_timestamp/3600:.2f} hours)")

# Create Arrow arrays with GeoArrow format
# This matches the exact format from generate_data.py
coords_fixed_size_list = pa.FixedSizeListArray.from_arrays(
    pa.array(coords.flatten("C")), 2
)
linestrings_arr = pa.ListArray.from_arrays(pa.array(offsets), coords_fixed_size_list)
timestamp_arr = pa.ListArray.from_arrays(pa.array(offsets), timestamps)
speeds_arr = pa.ListArray.from_arrays(pa.array(offsets), speeds)
edges_arr = pa.ListArray.from_arrays(pa.array(offsets), pa.array(edges))
positions_arr = pa.ListArray.from_arrays(pa.array(offsets), positions)
relative_speeds_arr = pa.ListArray.from_arrays(pa.array(offsets), relative_speeds)
angles_arr = pa.ListArray.from_arrays(pa.array(offsets), angles)

# Create Arrow table with geometry, timestamps, speeds, edges, positions, relative speeds, angles, and vehicle attributes
table = pa.table({
    "geometry": linestrings_arr,
    "timestamps": timestamp_arr,
    "speeds": speeds_arr,
    "edges": edges_arr,
    "positions": positions_arr,
    "relative_speeds": relative_speeds_arr,
    "angles": angles_arr,
    "vehicle_id": pa.array(vehicle_ids)
})

print(f"Writing {geoms_num} trips to {OUTPUT_FILE}...")
# Write uncompressed feather to memory buffer first
buffer = io.BytesIO()
feather.write_feather(table, buffer, compression="uncompressed")
buffer.seek(0)

# Compress with gzip (browsers can decompress this natively)
with gzip.open(OUTPUT_FILE, 'wb', compresslevel=9) as f:
    f.write(buffer.read())

original_size = len(buffer.getvalue())
compressed_size = os.path.getsize(OUTPUT_FILE)
compression_ratio = (1 - compressed_size / original_size) * 100

print("Done!")
print(f"Original size: {original_size / 1024:.1f} KB")
print(f"Compressed size: {compressed_size / 1024:.1f} KB")
print(f"Compression ratio: {compression_ratio:.1f}%")
print(f"\nOutput file: {OUTPUT_FILE}")
print(f"Number of trips: {geoms_num}")
print(f"Total positions: {coord_num}")


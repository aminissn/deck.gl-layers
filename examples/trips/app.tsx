import React, { useState, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { StaticMap, MapContext, NavigationControl } from "react-map-gl";
import DeckGL, { Layer, PickingInfo, LightingEffect } from "deck.gl";
import { AmbientLight, DirectionalLight } from "@deck.gl/core";
import { GeoArrowTripsLayer } from "@geoarrow/deck.gl-layers";
import { ScenegraphLayer } from "@deck.gl/mesh-layers";
import * as arrow from "apache-arrow";

// const GEOARROW_POINT_DATA = "http://localhost:8080/trips.feather.gz";
const GEOARROW_POINT_DATA = "/public/trips.feather.gz";

// Geneva, Switzerland coordinates
const INITIAL_VIEW_STATE = {
  longitude: 9.44,
  latitude: 47.52,
  zoom: 12,
  pitch: 45,
  bearing: 0,
};

const MAP_STYLE =
  "https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json";
const NAV_CONTROL_STYLE = {
  position: "absolute",
  top: 10,
  left: 10,
};

// Use a free 3D car model from deck.gl examples
// This is a simple low-poly car model that works well for visualization
const SCENEGRAPH_URL =
  "public/MercedesBenzGLS.glb";

// Create lighting effects for 3D models
// This makes PBR materials render correctly with colors instead of appearing white
const ambientLight = new AmbientLight({
  color: [255, 255, 255],
  intensity: 1.5,
});

const directionalLight = new DirectionalLight({
  color: [255, 255, 255],
  intensity: 1.5,
  direction: [-1, -3, -1], // Light coming from above and slightly from the side
});

const lightingEffect = new LightingEffect({ ambientLight, directionalLight });

// Helper types for vehicle position data
interface VehiclePosition {
  vehicleId: string;
  vehicleIndex: number;
  longitude: number;
  latitude: number;
  bearing: number;
  relativeSpeed: number;
}

/**
 * Compute the bearing (angle) between two points in degrees
 * Returns angle from north (0° = north, 90° = east, 180° = south, 270° = west)
 */
function computeBearing(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number
): number {
  const dLon = lon2 - lon1;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  return (bearing + 360) % 360;
}

/**
 * Get the current position and bearing for each vehicle at a given time
 * This interpolates between points based on timestamps
 * Now uses actual vehicle angle from SUMO data instead of computing bearing
 */
function getVehiclePositions(
  table: arrow.Table | null,
  currentTime: number
): VehiclePosition[] {
  if (!table) return [];

  const positions: VehiclePosition[] = [];
  const geometryColumn = table.getChild("geometry");
  const timestampsColumn = table.getChild("timestamps");
  const vehicleIdColumn = table.getChild("vehicle_id");
  const relativeSpeedsColumn = table.getChild("relative_speeds");
  const anglesColumn = table.getChild("angles");

  if (!geometryColumn || !timestampsColumn || !vehicleIdColumn) return [];

  for (let vehicleIdx = 0; vehicleIdx < table.numRows; vehicleIdx++) {
    const geometry = geometryColumn.get(vehicleIdx);
    const timestamps = timestampsColumn.get(vehicleIdx);
    const vehicleId = vehicleIdColumn?.get(vehicleIdx);
    const relativeSpeeds = relativeSpeedsColumn?.get(vehicleIdx);
    const angles = anglesColumn?.get(vehicleIdx);

    if (!geometry || !timestamps || timestamps.length === 0) continue;

    // Find the segment containing the current time
    let segmentStart = -1;
    for (let i = 0; i < timestamps.length - 1; i++) {
      const t1 = timestamps.get(i);
      const t2 = timestamps.get(i + 1);
      if (currentTime >= t1 && currentTime <= t2) {
        segmentStart = i;
        break;
      }
    }

    // If we found a valid segment, interpolate the position
    if (segmentStart >= 0) {
      const t1 = timestamps.get(segmentStart);
      const t2 = timestamps.get(segmentStart + 1);
      const progress = (currentTime - t1) / (t2 - t1);

      const point1 = geometry.get(segmentStart);
      const point2 = geometry.get(segmentStart + 1);

      const lon1 = point1.get(0);
      const lat1 = point1.get(1);
      const lon2 = point2.get(0);
      const lat2 = point2.get(1);

      // Interpolate position
      const longitude = lon1 + (lon2 - lon1) * progress;
      const latitude = lat1 + (lat2 - lat1) * progress;

      // Use actual vehicle angle from SUMO data, or fall back to computed bearing
      let bearing: number;
      if (angles) {
        // Interpolate angle between two points
        const angle1 = angles.get(segmentStart);
        const angle2 = angles.get(segmentStart + 1);
        // Handle angle wraparound (e.g., 359° to 1°)
        let angleDiff = angle2 - angle1;
        if (angleDiff > 180) angleDiff -= 360;
        if (angleDiff < -180) angleDiff += 360;
        bearing = (angle1 + angleDiff * progress + 360) % 360;
      } else {
        // Fallback: Calculate bearing from direction of travel
        bearing = computeBearing(lon1, lat1, lon2, lat2);
      }

      // Get relative speed for this position
      const relativeSpeed = relativeSpeeds
        ? relativeSpeeds.get(segmentStart)
        : 0.5;

      positions.push({
        vehicleId,
        vehicleIndex: vehicleIdx,
        longitude,
        latitude,
        bearing,
        relativeSpeed,
      });
    }
  }

  return positions;
}

function Root() {
  const trailLength = 5;

  const [time, setTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [animation] = useState<{ id: number }>({ id: 0 });
  const [table, setTable] = useState<arrow.Table | null>(null);
  const [timeRange, setTimeRange] = useState({ min: 0, max: 7200 });
  const [isDraggingSlider, setIsDraggingSlider] = useState(false);
  const [showCurrentTime, setShowCurrentTime] = useState(false);
  const [selectedVehicle, setSelectedVehicle] = useState<{
    id: string;
    index: number;
  } | null>(null);
  const [show3DVehicles, setShow3DVehicles] = useState(true);
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const [isTracking, setIsTracking] = useState(false);
  const [isProgrammaticUpdate, setIsProgrammaticUpdate] = useState(false);
  const [showInstructions, setShowInstructions] = useState(true);

  // Calculate min/max time from data when table loads
  useEffect(() => {
    if (table) {
      const timestampsColumn = table.getChild("timestamps");
      if (timestampsColumn) {
        let minTime = Infinity;
        let maxTime = -Infinity;
        
        // Iterate through all timestamp arrays
        for (let i = 0; i < timestampsColumn.length; i++) {
          const timestamps = timestampsColumn.get(i);
          if (timestamps && timestamps.length > 0) {
            for (let j = 0; j < timestamps.length; j++) {
              const t = timestamps.get(j);
              if (t < minTime) minTime = t;
              if (t > maxTime) maxTime = t;
            }
          }
        }
        
        setTimeRange({ min: minTime, max: maxTime });
        setTime(minTime);
        console.log(`Data time range: ${minTime}s to ${maxTime}s (${(maxTime - minTime) / 60} minutes)`);
      }
    }
  }, [table]);

  const animate = () => {
    if (isPlaying) {
      setTime((t) => {
        const nextTime = t + playbackSpeed;
        // Loop back to start when reaching the end
        return nextTime > timeRange.max ? timeRange.min : nextTime;
      });
    }
    animation.id = window.requestAnimationFrame(animate);
  };

  useEffect(() => {
    animation.id = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(animation.id);
  }, [animation, isPlaying, playbackSpeed, timeRange]);

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTime(Number(e.target.value));
    setShowCurrentTime(true);
  };

  const handleSliderMouseDown = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    setIsDraggingSlider(true);
  };

  const handleSliderMouseUp = () => {
    setIsDraggingSlider(false);
  };

  // Add global mouse up listener to catch when user releases outside slider
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      setIsDraggingSlider(false);
    };
    
    if (isDraggingSlider) {
      window.addEventListener('mouseup', handleGlobalMouseUp);
      window.addEventListener('touchend', handleGlobalMouseUp);
      return () => {
        window.removeEventListener('mouseup', handleGlobalMouseUp);
        window.removeEventListener('touchend', handleGlobalMouseUp);
      };
    }
  }, [isDraggingSlider]);

  const togglePlayPause = () => {
    setIsPlaying(!isPlaying);
    if (!isPlaying) {
      setShowCurrentTime(true);
    }
  };

  const formatTime = (seconds: number, includeSeconds: boolean = false) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (includeSeconds) {
      const secs = Math.floor(seconds % 60);
      return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    }
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
  };

  const speedOptions = [0.5, 1, 2, 5];
  
  const cycleSpeed = () => {
    const currentIndex = speedOptions.indexOf(playbackSpeed);
    const nextIndex = (currentIndex + 1) % speedOptions.length;
    setPlaybackSpeed(speedOptions[nextIndex]);
  };

  const onClick = (info: PickingInfo, event?: any) => {
    // Don't process clicks if they came from UI controls
    // Check if the click target is a button, input, or other control
    if (event?.target && (
      event.target.tagName === 'BUTTON' ||
      event.target.tagName === 'INPUT' ||
      event.target.closest('button') ||
      event.target.closest('input')
    )) {
      return; // Ignore clicks on UI controls
    }

    if (info.picked && table) {
      const vehicleIdColumn = table.getChild("vehicle_id");
      
      if (vehicleIdColumn) {
        let vehicleIndex: number;
        let vehicleId: string;
        
        // Check if clicked on 3D car (ScenegraphLayer) or trail (TripsLayer)
        if (info.layer?.id === "scenegraph-layer" && info.object) {
          // Clicked on 3D car - extract vehicleIndex from the data object
          const vehicleData = info.object as VehiclePosition;
          vehicleIndex = vehicleData.vehicleIndex;
          vehicleId = vehicleData.vehicleId;
        } else if (info.index !== undefined) {
          // Clicked on trips layer trail
          vehicleIndex = info.index;
          vehicleId = vehicleIdColumn.get(info.index);
        } else {
          // No valid selection - but keep current selection if exists
          return;
        }
        
        setSelectedVehicle({
          id: vehicleId,
          index: vehicleIndex
        });
        // Auto-enable tracking when selecting a vehicle
        setIsTracking(true);
        console.log(`Selected vehicle ${vehicleId} at index ${vehicleIndex}`);
      }
    } else if (!info.picked) {
      // Only deselect if clicked on actual empty map space
      // Don't deselect if there's a selected vehicle and we just clicked somewhere invalid
      if (selectedVehicle) {
        console.log("Clicked empty space - keeping selection");
        return; // Keep the current selection
      }
    }
  };

  // Color interpolation based on relative speed (0-1)
  // Red (slow) to green (fast)
  const getColorFromRelativeSpeed = (relativeSpeed: number): [number, number, number, number] => {
    // Clamp value between 0 and 1
    const clamped = Math.max(0, Math.min(1, relativeSpeed));
    
    // Red (slow) to green (fast)
    // Red: RGB(255, 0, 0)
    // Green: RGB(0, 255, 0)
    const r = Math.round(255 * (1 - clamped));
    const g = Math.round(255 * clamped);
    
    return [r, g, 0, 255];
  };

  // Get relative speed for a vehicle at current time
  const getRelativeSpeedAtTime = (vehicleIndex: number): number => {
    if (!table) return 0.5;

    const timestampsColumn = table.getChild("timestamps");
    const relativeSpeedsColumn = table.getChild("relative_speeds");

    if (!timestampsColumn || !relativeSpeedsColumn) return 0.5;

    const vehicleTimestamps = timestampsColumn.get(vehicleIndex);
    const vehicleRelativeSpeeds = relativeSpeedsColumn.get(vehicleIndex);

    if (!vehicleTimestamps || !vehicleRelativeSpeeds) return 0.5;

    // Find the data at or just before the current time
    let dataIndex = 0;
    for (let i = 0; i < vehicleTimestamps.length; i++) {
      const t = vehicleTimestamps.get(i);
      if (t >= time) {
        dataIndex = i > 0 ? i - 1 : 0;
        break;
      }
      dataIndex = i;
    }

    return vehicleRelativeSpeeds.get(dataIndex);
  };

  // Get instantaneous data for selected vehicle at current time
  const getCurrentVehicleData = (): { speed: number; edge: string; pos: number; relativeSpeed: number } | null => {
    if (!selectedVehicle || !table) return null;

    const timestampsColumn = table.getChild("timestamps");
    const speedsColumn = table.getChild("speeds");
    const edgesColumn = table.getChild("edges");
    const positionsColumn = table.getChild("positions");
    const relativeSpeedsColumn = table.getChild("relative_speeds");

    if (!timestampsColumn || !speedsColumn || !edgesColumn || !positionsColumn || !relativeSpeedsColumn) return null;

    const vehicleTimestamps = timestampsColumn.get(selectedVehicle.index);
    const vehicleSpeeds = speedsColumn.get(selectedVehicle.index);
    const vehicleEdges = edgesColumn.get(selectedVehicle.index);
    const vehiclePositions = positionsColumn.get(selectedVehicle.index);
    const vehicleRelativeSpeeds = relativeSpeedsColumn.get(selectedVehicle.index);

    if (!vehicleTimestamps || !vehicleSpeeds || !vehicleEdges || !vehiclePositions || !vehicleRelativeSpeeds) return null;

    // Find the data at or just before the current time
    let dataIndex = 0;
    for (let i = 0; i < vehicleTimestamps.length; i++) {
      const t = vehicleTimestamps.get(i);
      if (t >= time) {
        dataIndex = i > 0 ? i - 1 : 0;
        break;
      }
      dataIndex = i;
    }

    return {
      speed: vehicleSpeeds.get(dataIndex),
      edge: vehicleEdges.get(dataIndex),
      pos: vehiclePositions.get(dataIndex),
      relativeSpeed: vehicleRelativeSpeeds.get(dataIndex)
    };
  };

  useEffect(() => {
    // declare the data fetching function
    const fetchData = async () => {
      try {
        const response = await fetch(GEOARROW_POINT_DATA);
        
        // Check if the server already decompressed the file
        // (many dev servers auto-decompress .gz files)
        const contentEncoding = response.headers.get("content-encoding");
        
        let buffer: Uint8Array;
        
        if (contentEncoding === "gzip" || contentEncoding === "x-gzip") {
          // Server sent compressed data, browser will auto-decompress
          const arrayBuffer = await response.arrayBuffer();
          buffer = new Uint8Array(arrayBuffer);
        } else {
          // Check if data is gzipped by looking at magic bytes
          const arrayBuffer = await response.arrayBuffer();
          const firstBytes = new Uint8Array(arrayBuffer.slice(0, 2));
          const isGzipped = firstBytes[0] === 0x1f && firstBytes[1] === 0x8b;
          
          if (isGzipped) {
            // Data is gzipped, decompress it
            const decompressedStream = new Response(arrayBuffer).body!.pipeThrough(
              new DecompressionStream("gzip")
            );
            
            const reader = decompressedStream.getReader();
            const chunks: Uint8Array[] = [];
            let totalLength = 0;
            
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              totalLength += value.length;
            }
            
            buffer = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
              buffer.set(chunk, offset);
              offset += chunk.length;
            }
          } else {
            // Data is already uncompressed
            buffer = new Uint8Array(arrayBuffer);
          }
        }
        
        const table = arrow.tableFromIPC(buffer);
        setTable(table);
      } catch (error) {
        console.error("Error loading feather file:", error);
      }
    };

    if (!table) {
      fetchData();
    }
  });

  // Compute current vehicle positions for 3D models
  // This recalculates whenever time or table changes
  const vehiclePositions = useMemo(() => {
    return getVehiclePositions(table, time);
  }, [table, time]);

  // Track selected vehicle - update camera to follow it
  useEffect(() => {
    if (isTracking && selectedVehicle && vehiclePositions.length > 0) {
      // Find the current position of the selected vehicle
      const trackedVehicle = vehiclePositions.find(
        v => v.vehicleIndex === selectedVehicle.index
      );
      
      if (trackedVehicle) {
        // Mark this as a programmatic update to prevent tracking from being disabled
        setIsProgrammaticUpdate(true);
        // Smoothly move camera to follow the vehicle
        setViewState(prev => ({
          ...prev,
          longitude: trackedVehicle.longitude,
          latitude: trackedVehicle.latitude,
          transitionDuration: 100, // Smooth transition
          transitionInterpolator: undefined,
        }));
        // Reset flag after a short delay
        setTimeout(() => setIsProgrammaticUpdate(false), 150);
      }
    }
  }, [isTracking, selectedVehicle, vehiclePositions, time]);

  // Calculate vehicle size based on zoom level
  // Vehicles should scale with zoom but stay within min/max bounds
  // Using exponential scaling to make vehicles shrink faster
  const getVehicleSize = (zoom: number): number => {
    const MIN_SIZE = 1.5;  // Approximately 5m when zoomed in (zoom 17+)
    const MAX_SIZE = 10;   // Smaller max size for better middle-range appearance
    const MIN_ZOOM = 11;   // Zoom level for maximum size
    const MAX_ZOOM = 17;   // Zoom level for minimum size
    
    // Clamp to bounds
    if (zoom <= MIN_ZOOM) return MAX_SIZE;
    if (zoom >= MAX_ZOOM) return MIN_SIZE;
    
    // Use exponential scaling (shrinks faster as you zoom in)
    // This makes vehicles smaller in the middle ranges
    const zoomNormalized = (zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM);
    const exponentialFactor = Math.pow(zoomNormalized, 2); // Square for faster shrinking
    
    return MAX_SIZE - (MAX_SIZE - MIN_SIZE) * exponentialFactor;
  };

  const vehicleSize = getVehicleSize(viewState.zoom);

  const layers: Layer[] = [];

  table &&
    layers.push(
      new GeoArrowTripsLayer({
        id: "geoarrow-linestring",
        data: table,
        getColor: ((d: any) => {
          // The index is in d.index, not info.index!
          const vehicleIndex = d?.index;
          
          if (vehicleIndex === undefined) {
            return [255, 255, 0, 200]; // Fallback yellow
          }
          
          // Highlight selected vehicle in cyan/bright blue
          if (selectedVehicle && vehicleIndex === selectedVehicle.index) {
            return [0, 255, 255, 255];
          }
          
          // Color based on relative speed (red = slow, green = fast)
          const relativeSpeed = getRelativeSpeedAtTime(vehicleIndex);
          const color = getColorFromRelativeSpeed(relativeSpeed);
          
          return color;
        }) as any,
        getPath: table.getChild("geometry")!,
        getTimestamps: table.getChild("timestamps")!,
        widthMinPixels: 5,
        widthMaxPixels: 20,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 255],
        trailLength,
        currentTime: time,
        updateTriggers: {
          getColor: [time, selectedVehicle?.index],
        },
      }),
    );

  // Add 3D vehicle models
  if (show3DVehicles && vehiclePositions.length > 0) {
    layers.push(
      new ScenegraphLayer({
        id: "scenegraph-layer",
        data: vehiclePositions,
        // Use the car glTF model
        scenegraph: SCENEGRAPH_URL,
        // Position each car at its current location
        getPosition: (d: VehiclePosition) => [d.longitude, d.latitude, 0],
        // Orient the car in the direction of travel
        getOrientation: (d: VehiclePosition) => [0, 180 - d.bearing, 90],
        // Dynamic size based on zoom level (min ~5m at zoom 18+, max at zoom 12-)
        sizeScale: vehicleSize,
        // Enable picking so users can click on 3D cars
        pickable: true,
        // Use PBR lighting to render the model's materials correctly
        // The model has colored materials (Polar_White, ChromeBlack_Windows, etc.)
        _lighting: "pbr",
        // Highlight selected vehicle with scaling
        getScale: (d: VehiclePosition) => {
          const isSelected = selectedVehicle && d.vehicleIndex === selectedVehicle.index;
          return isSelected ? [1.5, 1.5, 1.5] : [1, 1, 1];
        },
        // Update when time, selection, or zoom changes
        updateTriggers: {
          getPosition: [time],
          getOrientation: [time],
          getScale: [selectedVehicle?.index],
          sizeScale: [vehicleSize],
        },
      })
    );
  }

  return (
    <DeckGL
      viewState={viewState}
      controller={{
        // Disable map interactions when dragging slider
        dragPan: !isDraggingSlider,
        dragRotate: !isDraggingSlider,
        scrollZoom: !isDraggingSlider,
        touchZoom: !isDraggingSlider,
        touchRotate: !isDraggingSlider,
        keyboard: !isDraggingSlider,
        doubleClickZoom: !isDraggingSlider,
      }}
      layers={layers}
      ContextProvider={MapContext.Provider as any}
      onClick={onClick}
      getCursor={({ isHovering }: { isHovering: boolean }) => 
        isHovering ? "pointer" : "grab"
      }
      // Track view state changes (zoom, pan, etc.) to adjust vehicle sizes
      onViewStateChange={({ viewState: newViewState }: any) => {
        // If user manually changes view while tracking, disable tracking
        // But ignore programmatic updates from the tracking effect
        if (isTracking && !isDraggingSlider && !isProgrammaticUpdate) {
          // Detect manual panning/zooming
          const manualChange = 
            Math.abs(newViewState.longitude - viewState.longitude) > 0.001 ||
            Math.abs(newViewState.latitude - viewState.latitude) > 0.001;
          
          if (manualChange) {
            setIsTracking(false);
          }
        }
        setViewState(newViewState);
        return newViewState;
      }}
      // Add lighting effects for 3D models to show materials correctly
      effects={[lightingEffect]}
    >
      <StaticMap mapStyle={MAP_STYLE} />
      <NavigationControl style={NAV_CONTROL_STYLE} />
      
      {/* 3D Toggle Button */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          top: "20px",
          left: "20px",
          zIndex: 1000,
          pointerEvents: "auto",
        }}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShow3DVehicles(!show3DVehicles);
          }}
          style={{
            backgroundColor: show3DVehicles ? "#28a745" : "#6c757d",
            color: "white",
            border: "none",
            padding: "10px 16px",
            borderRadius: "8px",
            cursor: "pointer",
            fontSize: "13px",
            fontWeight: "600",
            boxShadow: "0 2px 8px rgba(0, 0, 0, 0.15)",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            transition: "background-color 0.2s",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = show3DVehicles ? "#218838" : "#545b62";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = show3DVehicles ? "#28a745" : "#6c757d";
          }}
        >
          <span style={{ fontSize: "16px" }}>{show3DVehicles ? "🚗" : "📍"}</span>
          {show3DVehicles ? "3D Vehicles" : "Show 3D"}
        </button>
      </div>

      {/* Instructions Panel */}
      {!selectedVehicle && showInstructions && (
        <div
          style={{
            position: "absolute",
            top: "20px",
            right: "20px",
            backgroundColor: "rgba(0, 123, 255, 0.9)",
            color: "white",
            padding: "12px 16px",
            borderRadius: "8px",
            boxShadow: "0 2px 8px rgba(0, 0, 0, 0.15)",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            fontSize: "13px",
            fontWeight: "500",
            zIndex: 1000,
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: "12px",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <span>💡 Click on any vehicle to see its details</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowInstructions(false);
            }}
            style={{
              background: "none",
              border: "none",
              color: "white",
              fontSize: "18px",
              cursor: "pointer",
              padding: "0",
              lineHeight: "1",
              opacity: 0.8,
              transition: "opacity 0.2s",
            }}
            onMouseEnter={(e) => e.currentTarget.style.opacity = "1"}
            onMouseLeave={(e) => e.currentTarget.style.opacity = "0.8"}
          >
            ×
          </button>
        </div>
      )}
      
      {/* Time Controls */}
      <div 
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          bottom: "20px",
          left: "50%",
          transform: "translateX(-50%)",
          backgroundColor: "rgba(255, 255, 255, 0.95)",
          padding: "16px 24px 20px 24px",
          borderRadius: "12px",
          boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
          display: "flex",
          alignItems: "center",
          gap: "16px",
          minWidth: "600px",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          zIndex: 1000,
          pointerEvents: "auto",
        }}
      >
        {/* Play/Pause Button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            togglePlayPause();
          }}
          style={{
            width: "40px",
            height: "40px",
            borderRadius: "50%",
            border: "none",
            backgroundColor: "#007bff",
            color: "white",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "16px",
            fontWeight: "bold",
            transition: "background-color 0.2s",
            flexShrink: 0,
          }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "#0056b3"}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "#007bff"}
        >
          {isPlaying ? "⏸" : "▶"}
        </button>
        
        {/* Speed Control Button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            cycleSpeed();
          }}
          style={{
            padding: "8px 12px",
            borderRadius: "6px",
            border: "none",
            backgroundColor: "#6c757d",
            color: "white",
            cursor: "pointer",
            fontSize: "12px",
            fontWeight: "600",
            transition: "background-color 0.2s",
            flexShrink: 0,
            minWidth: "50px",
          }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "#545b62"}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "#6c757d"}
        >
          {playbackSpeed}x
        </button>
        
        {/* Time Slider Container */}
        <div 
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            position: "relative",
          }}
        >
          {/* Slider */}
          <div style={{ position: "relative" }}>
            <input
              type="range"
              min={timeRange.min}
              max={timeRange.max}
              value={time}
              onChange={handleSliderChange}
              onMouseDown={handleSliderMouseDown}
              onMouseUp={handleSliderMouseUp}
              onTouchStart={handleSliderMouseDown}
              onTouchEnd={handleSliderMouseUp}
              style={{
                width: "100%",
                height: "6px",
                borderRadius: "3px",
                outline: "none",
                background: `linear-gradient(to right, #007bff 0%, #007bff ${((time - timeRange.min) / (timeRange.max - timeRange.min)) * 100}%, #ddd ${((time - timeRange.min) / (timeRange.max - timeRange.min)) * 100}%, #ddd 100%)`,
                cursor: "pointer",
              }}
            />
          </div>
          
          {/* Start and End Time Labels Below Slider */}
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: "13px",
            color: "#555",
            fontWeight: "500",
            fontVariantNumeric: "tabular-nums",
            paddingLeft: "2px",
            paddingRight: "2px",
            marginTop: "2px",
          }}>
            <span>{formatTime(timeRange.min)}</span>
            <span>{formatTime(timeRange.max)}</span>
          </div>
          
          {/* Current Time Below Knob - Only show when playing or after interaction */}
          {showCurrentTime && (
            <div style={{
              position: "absolute",
              top: "30px",
              left: `calc(${((time - timeRange.min) / (timeRange.max - timeRange.min)) * 100}% - 30px)`,
              fontSize: "12px",
              fontWeight: "700",
              color: "#007bff",
              fontVariantNumeric: "tabular-nums",
              textAlign: "center",
              minWidth: "60px",
              pointerEvents: "none",
              backgroundColor: "rgba(255, 255, 255, 0.9)",
              padding: "2px 6px",
              borderRadius: "4px",
            }}>
              {formatTime(time, true)}
            </div>
          )}
        </div>
      </div>
      
      {/* Vehicle Info Panel */}
      {selectedVehicle && (() => {
        const vehicleData = getCurrentVehicleData();
        return (
          <div
            style={{
              position: "absolute",
              top: "20px",
              right: "20px",
              backgroundColor: "rgba(255, 255, 255, 0.95)",
              padding: "20px",
              borderRadius: "12px",
              boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
              minWidth: "280px",
              fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
              zIndex: 1000,
              pointerEvents: "auto",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "16px",
              borderBottom: "2px solid #007bff",
              paddingBottom: "8px",
            }}>
              <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "600", color: "#333" }}>
                Vehicle Details
              </h3>
              <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsTracking(!isTracking);
                  }}
                  style={{
                    background: isTracking ? "#28a745" : "#6c757d",
                    border: "none",
                    borderRadius: "6px",
                    padding: "6px 12px",
                    fontSize: "12px",
                    fontWeight: "600",
                    cursor: "pointer",
                    color: "white",
                    transition: "background-color 0.2s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = isTracking ? "#218838" : "#545b62";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = isTracking ? "#28a745" : "#6c757d";
                  }}
                >
                  {isTracking ? "📍 Tracking" : "Track"}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedVehicle(null);
                    setIsTracking(false);
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    fontSize: "20px",
                    cursor: "pointer",
                    color: "#999",
                    padding: "0",
                    lineHeight: "1",
                  }}
                >
                  ×
                </button>
              </div>
            </div>
            
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                <tr style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "10px 0", fontWeight: "600", color: "#555", fontSize: "14px" }}>
                    Vehicle ID
                  </td>
                  <td style={{ padding: "10px 0", textAlign: "right", color: "#333", fontFamily: "monospace" }}>
                    {selectedVehicle.id}
                  </td>
                </tr>
                <tr style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "10px 0", fontWeight: "600", color: "#555", fontSize: "14px" }}>
                    Speed
                  </td>
                  <td style={{ padding: "10px 0", textAlign: "right", color: "#007bff", fontWeight: "600", fontSize: "15px" }}>
                    {vehicleData ? `${Math.round(vehicleData.speed * 3.6).toFixed(1)} km/h` : "N/A"}
                  </td>
                </tr>
                <tr style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "10px 0", fontWeight: "600", color: "#555", fontSize: "14px" }}>
                    Relative Speed
                  </td>
                  <td style={{ 
                    padding: "10px 0", 
                    textAlign: "right", 
                    fontWeight: "600", 
                    fontSize: "14px",
                    color: vehicleData ? `rgb(${getColorFromRelativeSpeed(vehicleData.relativeSpeed)[0]}, ${getColorFromRelativeSpeed(vehicleData.relativeSpeed)[1]}, 0)` : "#333"
                  }}>
                    {vehicleData ? `${(vehicleData.relativeSpeed * 100).toFixed(0)}%` : "N/A"}
                  </td>
                </tr>
                <tr style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "10px 0", fontWeight: "600", color: "#555", fontSize: "14px" }}>
                    Edge
                  </td>
                  <td style={{ padding: "10px 0", textAlign: "right", color: "#333", fontFamily: "monospace", fontSize: "13px" }}>
                    {vehicleData ? vehicleData.edge : "N/A"}
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: "10px 0", fontWeight: "600", color: "#555", fontSize: "14px" }}>
                    Position
                  </td>
                  <td style={{ padding: "10px 0", textAlign: "right", color: "#333", fontFamily: "monospace" }}>
                    {vehicleData ? `${vehicleData.pos.toFixed(2)} m` : "N/A"}
                  </td>
                </tr>
              </tbody>
            </table>
            
            <div style={{
              marginTop: "12px",
              fontSize: "11px",
              color: "#888",
              fontStyle: "italic",
            }}>
              Updates in real-time • Click anywhere to deselect
            </div>
          </div>
        );
      })()}
    </DeckGL>
  );
}

/* global document */
// Add custom slider styles
const style = document.createElement("style");
style.textContent = `
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #007bff;
    cursor: pointer;
    border: 2px solid white;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  }
  
  input[type="range"]::-moz-range-thumb {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #007bff;
    cursor: pointer;
    border: 2px solid white;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  }
  
  input[type="range"]::-webkit-slider-thumb:hover {
    background: #0056b3;
  }
  
  input[type="range"]::-moz-range-thumb:hover {
    background: #0056b3;
  }
`;
document.head.appendChild(style);

const container = document.body.appendChild(document.createElement("div"));
createRoot(container).render(<Root />);

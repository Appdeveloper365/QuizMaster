# CMake configuration for QuizMaster Android Native Library
# This file tells the Android build system how to compile the Rust native library

cmake_minimum_required(VERSION 3.22)
project("quizmastermind-lib" LANGUAGES C Rust)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Find required packages
find_package(NDK Android ${ANDROID_NDK_VERSION})

# Set build type if not specified
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# Rust source files
set(RUST_SOURCES
    src/local_ai.rs
    src/storage.rs
    src/quiz_engine.rs
)

# Create native library
add_library(${PROJECT_NAME} SHARED ${RUST_SOURCES})

# Set include directories
target_include_directories(${PROJECT_NAME} PRIVATE ${CMAKE_SOURCE_DIR}/src/)

# Link with Android NDK libraries
target_link_libraries(${PROJECT_NAME}
    android
    log
)

# WebGPU support flag for Android WebView
if(ENABLE_WEBGPU)
    target_compile_definitions(${PROJECT_NAME} PRIVATE WEBGPU_ENABLED=1
    )
endif()

# Optimization flags for release builds
if(CMAKE_BUILD_TYPE STREQUAL "Release")
    set_target_properties(${PROJECT_NAME} PROPERTIES
        # Optimize for speed
        CODEGEN_OPTIMIZATION_LEVELS "Ag"
        # Enable LTO
        CXX_FLAGS "-flto"
        # Strip debug symbols
        POSITION_INDEPENDENT_CODE ON
    )
endif()

# Install target library to Android output directory
install(TARGETS ${PROJECT_NAME}
    LIBRARY DESTINATION src/main/assets/
)

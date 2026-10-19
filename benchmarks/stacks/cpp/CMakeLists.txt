cmake_minimum_required(VERSION 3.20)
project(qsbench_cpp CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(Drogon CONFIG REQUIRED)

add_executable(server
  src/main.cc
  src/common.cc
  src/query.cc
  src/records.cc
  src/users.cc
  src/organizations.cc
  src/media.cc)
target_compile_options(server PRIVATE -Wall -Wextra)
target_link_libraries(server PRIVATE Drogon::Drogon)

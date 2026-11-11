{
  "targets": [
    {
      "target_name": "journal_win32",
      "sources": ["journal.cc"],
      "defines": ["NAPI_VERSION=8"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_cc": ["-std=c++17"],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17"
      },
      "conditions": [
        ["OS=='win'", {
          "defines": ["UNICODE", "_UNICODE", "NOMINMAX", "_WIN32_WINNT=0x0602"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++17"]
            }
          }
        }]
      ]
    }
  ]
}

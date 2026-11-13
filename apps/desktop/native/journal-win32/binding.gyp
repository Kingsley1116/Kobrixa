{
  "variables": { "journal_test_hooks%": 0 },
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
        [
          "journal_test_hooks==1 or journal_test_hooks=='1'",
          { "defines": ["JOURNAL_TEST_HOOKS=1"] }
        ],
        [
          "OS=='win'",
          {
            "libraries": ["Advapi32.lib"],
            "defines": ["UNICODE", "_UNICODE", "NOMINMAX", "_WIN32_WINNT=0x0A00"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "AdditionalOptions": ["/std:c++17"]
              }
            }
          }
        ]
      ]
    }
  ]
}

def test_scripts_expose_main(statsgen, sitegen):
    assert callable(statsgen.main)
    assert callable(sitegen.main)

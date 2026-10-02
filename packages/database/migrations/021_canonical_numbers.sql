CREATE FUNCTION rootset_control.canonical_number(value_arg numeric) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE original float8:=value_arg::float8; approximate numeric; candidate numeric; magnitude integer;
 precision_arg integer; output text; integer_part text; fraction_part text; digits text; exponent_arg integer; negative_arg text;
BEGIN
 IF original=0 THEN RETURN '0'; END IF;
 approximate:=original::text::numeric;
 magnitude:=floor(log(10::numeric,abs(approximate)))::integer;
 FOR precision_arg IN 1..17 LOOP
   candidate:=round(approximate,precision_arg-1-magnitude);
   BEGIN
     IF candidate::float8=original THEN EXIT; END IF;
   EXCEPTION WHEN numeric_value_out_of_range THEN NULL;
   END;
 END LOOP;
 negative_arg:=CASE WHEN candidate<0 THEN '-' ELSE '' END;
 output:=abs(candidate)::text;
 integer_part:=split_part(output,'.',1);
 fraction_part:=rtrim(split_part(output,'.',2),'0');
 IF integer_part='0' THEN exponent_arg:=-1-(length(fraction_part)-length(ltrim(fraction_part,'0')));
 ELSE exponent_arg:=length(integer_part)-1; END IF;
 IF exponent_arg>=-6 AND exponent_arg<21 THEN
   RETURN negative_arg||integer_part||CASE WHEN fraction_part<>'' THEN '.'||fraction_part ELSE '' END;
 END IF;
 digits:=rtrim(ltrim(integer_part||fraction_part,'0'),'0');
 RETURN negative_arg||left(digits,1)||CASE WHEN length(digits)>1 THEN '.'||substr(digits,2) ELSE '' END
   ||'e'||CASE WHEN exponent_arg>=0 THEN '+' ELSE '' END||exponent_arg::text;
END $$;

CREATE OR REPLACE FUNCTION rootset_control.canonical_json(v jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE output text;
BEGIN
 CASE jsonb_typeof(v)
 WHEN 'object' THEN
   SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||rootset_control.canonical_json(value),',' ORDER BY key COLLATE "C"),'')||'}' INTO output FROM jsonb_each(v);
   RETURN output;
 WHEN 'array' THEN
   SELECT '['||coalesce(string_agg(rootset_control.canonical_json(value),',' ORDER BY ord),'')||']' INTO output FROM jsonb_array_elements(v) WITH ORDINALITY item(value,ord);
   RETURN output;
 WHEN 'number' THEN RETURN rootset_control.canonical_number(v::text::numeric);
 ELSE RETURN v::text;
 END CASE;
END $$;
